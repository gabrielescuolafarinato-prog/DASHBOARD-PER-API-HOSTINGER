import "server-only";
import {
  and,
  desc,
  eq,
  gte,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { hostingerOperations } from "@/db/schema";
import { operationMigrationRequiredError } from "./operation-schema-diagnostic";

export const NODE_RESTART_OPERATION = "node.restart";
export const NODE_RESTART_COOLDOWN_SECONDS = 30;
export const HOSTINGER_OPERATION_STALE_SECONDS = 120;

export type HostingerOperationStatus =
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED";

export type HostingerOperationRecord = {
  status: HostingerOperationStatus;
  referenceId: string;
  correlationId?: string;
  createdAt: Date;
};

export type HostingerOperationClaim =
  | { kind: "claimed"; operation: HostingerOperationRecord }
  | { kind: "duplicate"; operation: HostingerOperationRecord }
  | {
      kind: "blocked";
      reason: "in_progress" | "cooldown";
      operation: HostingerOperationRecord;
    };

export type OperationQueryExecutor = (query: SQL) => Promise<unknown>;
export type HostingerOperationInput = {
  siteId: string;
  actorUserId: string;
  operationType: string;
  resourceKeyHash?: string;
  idempotencyKeyHash: string;
  referenceId: string;
  cooldownSeconds?: number;
};
type OperationConflictLookup = (
  input: Parameters<typeof buildOperationClaimQuery>[0],
) => Promise<Exclude<HostingerOperationClaim, { kind: "claimed" }>>;

class OperationClaimDecodeError extends Error {
  constructor(readonly reason: "zero_rows" | "malformed") {
    super("Hostinger operation claim returned an invalid result.");
    this.name = "OperationClaimDecodeError";
  }
}

const claimRowSchema = z
  .object({
    outcome: z.enum([
      "CLAIMED",
      "DUPLICATE",
      "IN_PROGRESS",
      "COOLDOWN",
    ]),
    status: z.enum(["IN_PROGRESS", "SUCCEEDED", "FAILED"]),
    reference_id: z.string().regex(/^[a-f0-9]{12}$/),
    correlation_id: z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,200}$/)
      .refine((value) => !value.includes("://"))
      .nullable(),
    created_at_epoch: z.number().finite().nonnegative(),
  })
  .strict();

export async function claimHostingerOperation(
  input: HostingerOperationInput,
  dependencies: {
    execute?: OperationQueryExecutor;
    expireStale?: typeof expireStaleHostingerOperation;
    lookupConflict?: OperationConflictLookup;
  } = {},
): Promise<HostingerOperationClaim> {
  const expireStale =
    dependencies.expireStale ?? expireStaleHostingerOperation;
  await expireStale(
    input.siteId,
    input.operationType,
    input.resourceKeyHash,
  );
  const execute = dependencies.execute ?? executeOperationQuery;
  let result: unknown;
  try {
    result = await execute(buildOperationClaimQuery(input));
  } catch (error) {
    throw operationMigrationRequiredError(error) ?? error;
  }
  try {
    return decodeOperationClaim(result);
  } catch (error) {
    if (
      !(error instanceof OperationClaimDecodeError) ||
      error.reason !== "zero_rows"
    ) {
      throw error;
    }
    const lookupConflict =
      dependencies.lookupConflict ?? lookupOperationAfterConflict;
    return await lookupConflict(input);
  }
}

export function buildOperationClaimQuery(input: HostingerOperationInput) {
  const cooldownSeconds =
    input.cooldownSeconds ??
    (input.operationType === NODE_RESTART_OPERATION
      ? NODE_RESTART_COOLDOWN_SECONDS
      : 0);
  const cooldownCutoff = new Date(
    Date.now() - cooldownSeconds * 1_000,
  );
  const lockScope = input.resourceKeyHash ?? input.operationType;
  return sql`
    WITH operation_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${input.siteId}::text || ':' || ${lockScope}::text,
          918273645
        )
      ) AS locked
    ),
    existing_operation AS MATERIALIZED (
      SELECT
        operation.status,
        operation.reference_id,
        operation.correlation_id,
        operation.created_at
      FROM hostinger_operations operation
      INNER JOIN operation_lock ON true
      WHERE operation.site_id = ${input.siteId}::uuid
        AND operation.operation_type = ${input.operationType}
        AND operation.idempotency_key_hash = ${input.idempotencyKeyHash}
      LIMIT 1
    ),
    blocking_operation AS MATERIALIZED (
      SELECT
        operation.status,
        operation.reference_id,
        operation.correlation_id,
        operation.created_at
      FROM hostinger_operations operation
      INNER JOIN operation_lock ON true
      WHERE operation.site_id = ${input.siteId}::uuid
        AND (
          (
            ${input.resourceKeyHash ?? null}::text IS NOT NULL
            AND operation.resource_key_hash = ${input.resourceKeyHash ?? null}
            AND operation.status = 'IN_PROGRESS'::hostinger_operation_status
          )
          OR (
            ${input.resourceKeyHash ?? null}::text IS NULL
            AND operation.resource_key_hash IS NULL
            AND operation.operation_type = ${input.operationType}
            AND (
              operation.status = 'IN_PROGRESS'::hostinger_operation_status
              OR (
                ${cooldownSeconds}::integer > 0
                AND operation.created_at >= ${cooldownCutoff}
              )
            )
          )
        )
      ORDER BY operation.created_at DESC
      LIMIT 1
    ),
    inserted_operation AS (
      INSERT INTO hostinger_operations (
        site_id,
        actor_user_id,
        operation_type,
        resource_key_hash,
        idempotency_key_hash,
        status,
        reference_id,
        created_at,
        updated_at
      )
      SELECT
        ${input.siteId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.operationType},
        ${input.resourceKeyHash ?? null},
        ${input.idempotencyKeyHash},
        'IN_PROGRESS'::hostinger_operation_status,
        ${input.referenceId},
        now(),
        now()
      FROM operation_lock
      WHERE NOT EXISTS (SELECT 1 FROM existing_operation)
        AND NOT EXISTS (SELECT 1 FROM blocking_operation)
      ON CONFLICT DO NOTHING
      RETURNING status, reference_id, correlation_id, created_at
    )
    SELECT
      'CLAIMED'::text AS outcome,
      status::text AS status,
      reference_id,
      correlation_id,
      extract(epoch FROM created_at)::double precision AS created_at_epoch
    FROM inserted_operation

    UNION ALL

    SELECT
      'DUPLICATE'::text AS outcome,
      status::text AS status,
      reference_id,
      correlation_id,
      extract(epoch FROM created_at)::double precision AS created_at_epoch
    FROM existing_operation
    WHERE NOT EXISTS (SELECT 1 FROM inserted_operation)

    UNION ALL

    SELECT
      CASE
        WHEN status = 'IN_PROGRESS'::hostinger_operation_status
          THEN 'IN_PROGRESS'
        ELSE 'COOLDOWN'
      END AS outcome,
      status::text AS status,
      reference_id,
      correlation_id,
      extract(epoch FROM created_at)::double precision AS created_at_epoch
    FROM blocking_operation
    WHERE NOT EXISTS (SELECT 1 FROM inserted_operation)
      AND NOT EXISTS (SELECT 1 FROM existing_operation)
    LIMIT 1
  `;
}

export function decodeOperationClaim(
  result: unknown,
): HostingerOperationClaim {
  const rows = documentedResultRows(result);
  if (rows?.length === 0) {
    throw new OperationClaimDecodeError("zero_rows");
  }
  if (!rows || rows.length !== 1) {
    throw new OperationClaimDecodeError("malformed");
  }
  const parsed = claimRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    throw new OperationClaimDecodeError("malformed");
  }
  const operation: HostingerOperationRecord = {
    status: parsed.data.status,
    referenceId: parsed.data.reference_id,
    correlationId: parsed.data.correlation_id ?? undefined,
    createdAt: new Date(parsed.data.created_at_epoch * 1_000),
  };
  if (parsed.data.outcome === "CLAIMED") {
    return { kind: "claimed", operation };
  }
  if (parsed.data.outcome === "DUPLICATE") {
    return { kind: "duplicate", operation };
  }
  return {
    kind: "blocked",
    reason:
      parsed.data.outcome === "IN_PROGRESS"
        ? "in_progress"
        : "cooldown",
    operation,
  };
}

export async function finishHostingerOperation(
  input: {
    siteId: string;
    operationType: string;
    idempotencyKeyHash: string;
    status: "SUCCEEDED" | "FAILED";
    correlationId?: string;
  },
): Promise<boolean> {
  const correlationId = sanitizeCorrelationId(input.correlationId);
  try {
    const rows = await getDb()
      .update(hostingerOperations)
      .set({
        status: input.status,
        correlationId: correlationId ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hostingerOperations.siteId, input.siteId),
          eq(hostingerOperations.operationType, input.operationType),
          eq(
            hostingerOperations.idempotencyKeyHash,
            input.idempotencyKeyHash,
          ),
          eq(hostingerOperations.status, "IN_PROGRESS"),
        ),
      )
      .returning({ referenceId: hostingerOperations.referenceId });
    return rows.length === 1;
  } catch (error) {
    throw operationMigrationRequiredError(error) ?? error;
  }
}

export async function getNodeRestartBlockedUntil(
  siteId: string,
): Promise<Date | undefined> {
  const cooldownCutoff = new Date(
    Date.now() - NODE_RESTART_COOLDOWN_SECONDS * 1_000,
  );
  try {
    const [operation] = await getDb()
      .select({
        status: hostingerOperations.status,
        createdAt: hostingerOperations.createdAt,
      })
      .from(hostingerOperations)
      .where(
        and(
          eq(hostingerOperations.siteId, siteId),
          eq(
            hostingerOperations.operationType,
            NODE_RESTART_OPERATION,
          ),
          or(
            eq(hostingerOperations.status, "IN_PROGRESS"),
            gte(hostingerOperations.createdAt, cooldownCutoff),
          ),
        ),
      )
      .orderBy(desc(hostingerOperations.createdAt))
      .limit(1);
    if (!operation) return undefined;
    const seconds =
      operation.status === "IN_PROGRESS"
        ? HOSTINGER_OPERATION_STALE_SECONDS
        : NODE_RESTART_COOLDOWN_SECONDS;
    return new Date(operation.createdAt.getTime() + seconds * 1_000);
  } catch (error) {
    throw operationMigrationRequiredError(error) ?? error;
  }
}

export async function getNodeRestartCooldownSeconds(siteId: string) {
  const blockedUntil = await getNodeRestartBlockedUntil(siteId);
  return blockedUntil
    ? Math.max(
        0,
        Math.ceil((blockedUntil.getTime() - Date.now()) / 1_000),
      )
    : 0;
}

async function expireStaleHostingerOperation(
  siteId: string,
  operationType: string,
  resourceKeyHash?: string,
) {
  const staleCutoff = new Date(
    Date.now() - HOSTINGER_OPERATION_STALE_SECONDS * 1_000,
  );
  try {
    await getDb()
      .update(hostingerOperations)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hostingerOperations.siteId, siteId),
          resourceKeyHash
            ? eq(hostingerOperations.resourceKeyHash, resourceKeyHash)
            : and(
                eq(hostingerOperations.operationType, operationType),
                isNull(hostingerOperations.resourceKeyHash),
              ),
          eq(hostingerOperations.status, "IN_PROGRESS"),
          lt(hostingerOperations.createdAt, staleCutoff),
        ),
      );
  } catch (error) {
    throw operationMigrationRequiredError(error) ?? error;
  }
}

async function lookupOperationAfterConflict(
  input: Parameters<typeof buildOperationClaimQuery>[0],
): Promise<Exclude<HostingerOperationClaim, { kind: "claimed" }>> {
  const cooldownSeconds =
    input.cooldownSeconds ??
    (input.operationType === NODE_RESTART_OPERATION
      ? NODE_RESTART_COOLDOWN_SECONDS
      : 0);
  const cooldownCutoff = new Date(
    Date.now() - cooldownSeconds * 1_000,
  );
  try {
    const [existing] = await getDb()
      .select({
        status: hostingerOperations.status,
        referenceId: hostingerOperations.referenceId,
        correlationId: hostingerOperations.correlationId,
        createdAt: hostingerOperations.createdAt,
      })
      .from(hostingerOperations)
      .where(
        and(
          eq(hostingerOperations.siteId, input.siteId),
          eq(hostingerOperations.operationType, input.operationType),
          eq(
            hostingerOperations.idempotencyKeyHash,
            input.idempotencyKeyHash,
          ),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        kind: "duplicate",
        operation: normalizeSelectedOperation(existing),
      };
    }

    const [recent] = await getDb()
      .select({
        status: hostingerOperations.status,
        referenceId: hostingerOperations.referenceId,
        correlationId: hostingerOperations.correlationId,
        createdAt: hostingerOperations.createdAt,
      })
      .from(hostingerOperations)
      .where(
        and(
          eq(hostingerOperations.siteId, input.siteId),
          input.resourceKeyHash
            ? and(
                eq(
                  hostingerOperations.resourceKeyHash,
                  input.resourceKeyHash,
                ),
                eq(hostingerOperations.status, "IN_PROGRESS"),
              )
            : and(
                eq(
                  hostingerOperations.operationType,
                  input.operationType,
                ),
                isNull(hostingerOperations.resourceKeyHash),
                cooldownSeconds > 0
                  ? or(
                      eq(hostingerOperations.status, "IN_PROGRESS"),
                      gte(
                        hostingerOperations.createdAt,
                        cooldownCutoff,
                      ),
                    )
                  : eq(
                      hostingerOperations.status,
                      "IN_PROGRESS",
                    ),
              ),
        ),
      )
      .orderBy(desc(hostingerOperations.createdAt))
      .limit(1);
    if (recent) {
      const operation = normalizeSelectedOperation(recent);
      return {
        kind: "blocked",
        reason:
          operation.status === "IN_PROGRESS"
            ? "in_progress"
            : "cooldown",
        operation,
      };
    }
  } catch (error) {
    throw operationMigrationRequiredError(error) ?? error;
  }
  throw new Error("Hostinger operation conflict could not be resolved.");
}

async function executeOperationQuery(query: SQL) {
  return await getDb().execute(query);
}

function normalizeSelectedOperation(input: {
  status: HostingerOperationStatus;
  referenceId: string;
  correlationId: string | null;
  createdAt: Date;
}): HostingerOperationRecord {
  return {
    status: input.status,
    referenceId: input.referenceId,
    correlationId:
      sanitizeCorrelationId(input.correlationId) ?? undefined,
    createdAt: input.createdAt,
  };
}

function sanitizeCorrelationId(value: unknown) {
  return typeof value === "string" &&
    /^[A-Za-z0-9._:/-]{1,200}$/.test(value) &&
    !value.includes("://")
    ? value
    : undefined;
}

function documentedResultRows(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result;
  const parsed = z
    .object({
      rows: z.array(z.unknown()),
      fields: z.array(z.unknown()),
      command: z.literal("SELECT"),
      rowCount: z.number().int().nonnegative(),
      rowAsArray: z.literal(false),
    })
    .passthrough()
    .safeParse(result);
  return parsed.success &&
    parsed.data.rowCount === parsed.data.rows.length
    ? parsed.data.rows
    : null;
}
