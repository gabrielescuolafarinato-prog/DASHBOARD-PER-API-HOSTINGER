import "server-only";
import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { writeAuditEvent, hashAuditIdentifier } from "@/lib/audit";
import {
  getHostingerConfigurationState,
  getHostingerEnv,
} from "@/lib/env";
import {
  createHostingerClient,
  type HostingerClient,
  type HostingerWebsite,
} from "@/lib/hostinger/client";
import { normalizeDomain } from "@/lib/hostinger/domain";
import { AppError } from "@/lib/errors";
import { emitStructuredDiagnostic } from "./structured-diagnostic";

export type VerifiedConfiguredSite = {
  domain: string;
  username: string;
  orderId?: string;
  siteStatus: "VERIFIED";
  nodeEnabled: true;
  correlationId?: string;
};

export type SiteImportConflictReason =
  | "different_site"
  | "membership_conflict"
  | "username_conflict"
  | "ambiguous_state"
  | "unique_violation";

export type ImportFailurePhase =
  | "precheck"
  | "hostinger_reverification"
  | "database_import"
  | "result_decode"
  | "postcondition"
  | "redirect";

export type HostingerVerificationFailureCode =
  | "SITE_NOT_FOUND"
  | "NOT_NODE_JS"
  | "RATE_LIMITED"
  | "HOSTINGER_ERROR";

export type HostingerSiteImportOutcome =
  | { type: "imported"; siteId: string }
  | { type: "already_imported"; siteId: string }
  | {
      type: "single_site_conflict";
      reason: SiteImportConflictReason;
    }
  | {
      type: "verification_failed";
      code: HostingerVerificationFailureCode;
    }
  | {
      type: "persistence_failed";
      referenceId: string;
      phase: Exclude<ImportFailurePhase, "redirect">;
    };

export type SiteImportPrecheckOutcome =
  | { type: "ready" }
  | Extract<
      HostingerSiteImportOutcome,
      {
        type:
          | "already_imported"
          | "single_site_conflict"
          | "persistence_failed";
      }
    >;

type ImportQueryRow = {
  outcome: "imported" | "already_completed" | "conflict";
  site_id: string | null;
  conflict_reason: SiteImportConflictReason | null;
};

export type ImportQueryExecutor = (query: SQL) => Promise<unknown>;
export type ImportStateQueryExecutor = (query: SQL) => Promise<unknown>;

export type ImportDependencies = {
  executeImport?: ImportQueryExecutor;
  queryState?: ImportStateQueryExecutor;
};

type ImportStateRow = {
  site_id: string | null;
  target_site_count: number;
  other_site_count: number;
  username_match_count: number;
  verified_node_match_count: number;
  order_match_count: number;
  owner_admin_membership_count: number;
  owner_membership_count: number;
  primary_binding_match_count: number;
  primary_binding_count: number;
};

const importQueryRowSchema = z
  .object({
    outcome: z.enum(["imported", "already_completed", "conflict"]),
    site_id: z.string().uuid().nullable(),
    conflict_reason: z
      .enum([
        "different_site",
        "membership_conflict",
        "username_conflict",
        "ambiguous_state",
        "unique_violation",
      ])
      .nullable(),
  })
  .strict();

const importStateRowSchema = z
  .object({
    site_id: z.string().uuid().nullable(),
    target_site_count: z.number().int().nonnegative(),
    other_site_count: z.number().int().nonnegative(),
    username_match_count: z.number().int().nonnegative(),
    verified_node_match_count: z.number().int().nonnegative(),
    order_match_count: z.number().int().nonnegative(),
    owner_admin_membership_count: z.number().int().nonnegative(),
    owner_membership_count: z.number().int().nonnegative(),
    primary_binding_match_count: z.number().int().nonnegative(),
    primary_binding_count: z.number().int().nonnegative(),
  })
  .strict();

export function selectExactWebsite(
  configuredDomain: string,
  configuredUsername: string,
  candidates: readonly HostingerWebsite[],
) {
  const domain = normalizeDomain(configuredDomain);
  const exact = candidates.filter(
    (candidate) =>
      normalizeDomain(candidate.domain) === domain &&
      candidate.username === configuredUsername,
  );
  if (exact.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "The configured Hostinger site was not found.",
      404,
    );
  }
  if (exact.length > 1) {
    throw new AppError(
      "CONFLICT",
      "Hostinger returned an ambiguous site match.",
      409,
    );
  }
  return exact[0];
}

export async function verifyConfiguredHostingerSite(
  actorUserId: string,
  client?: HostingerClient,
): Promise<VerifiedConfiguredSite> {
  const configuration = getHostingerConfigurationState();
  if (!configuration.configured) {
    throw new AppError(
      "HOSTINGER_ERROR",
      configuration.status === "incomplete"
        ? "Hostinger configuration is incomplete."
        : "Hostinger is not configured correctly.",
      503,
    );
  }
  const env = getHostingerEnv();
  const domain = configuration.domain;
  const username = env.HOSTINGER_ACCOUNT_USERNAME;
  if (!username) {
    throw new AppError(
      "HOSTINGER_ERROR",
      "Hostinger is not configured correctly.",
      503,
    );
  }
  const activeClient = client ?? createHostingerClient();

  await writeAuditEvent({
    actorUserId,
    operation: "hostinger_site_verification_started",
    targetType: "site",
    targetIdentifier: domain,
    result: "SUCCESS",
    metadata: { phase: "discovery" },
  });

  try {
    const discovered = await activeClient.listWebsitesForConfiguredSite(
      domain,
      username,
    );
    // The client already post-filters. This second exact check keeps the
    // service fail-closed if a different client implementation is injected.
    const website = selectExactWebsite(
      domain,
      username,
      discovered.matches,
    );

    let nodeProbe;
    try {
      nodeProbe = await activeClient.verifyConfiguredNodeSite(username, domain);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        throw new AppError(
          "HOSTINGER_NOT_NODE",
          "The configured site could not be confirmed as a Node.js site.",
          422,
          error.correlationId,
        );
      }
      throw error;
    }

    const correlationId =
      nodeProbe.correlationId ?? discovered.correlationId;
    await writeAuditEvent({
      actorUserId,
      operation: "hostinger_site_verification_succeeded",
      targetType: "site",
      targetIdentifier: domain,
      result: "SUCCESS",
      metadata: {
        correlationId,
        nodeEnabled: true,
      },
    });

    return {
      domain,
      username,
      orderId: website.orderId,
      siteStatus: "VERIFIED",
      nodeEnabled: true,
      correlationId,
    };
  } catch (error) {
    await writeAuditEvent({
      actorUserId,
      operation: "hostinger_site_verification_failed",
      targetType: "site",
      targetIdentifier: domain,
      result: "FAILURE",
      metadata: {
        errorCode:
          error instanceof AppError ? error.code : "INTERNAL_ERROR",
        correlationId:
          error instanceof AppError ? error.correlationId : undefined,
      },
    });
    throw error;
  }
}

/**
 * Persists the verified site boundary in one PostgreSQL statement.
 *
 * Neon HTTP cannot run interactive callback transactions. A single statement
 * is nevertheless an atomic PostgreSQL transaction. The transaction-scoped
 * advisory lock serializes every single-site import, while existing unique
 * indexes protect domain, membership and binding identities.
 */
export async function importVerifiedConfiguredSite(
  actorUserId: string,
  verified: VerifiedConfiguredSite,
  dependencies: ImportDependencies = {},
): Promise<HostingerSiteImportOutcome> {
  const domain = normalizeDomain(verified.domain);
  if (!verified.nodeEnabled || verified.siteStatus !== "VERIFIED") {
    return { type: "verification_failed", code: "NOT_NODE_JS" };
  }

  const query = buildAtomicImportQuery({
    actorUserId,
    domain,
    username: verified.username,
    orderId: verified.orderId,
    correlationId: verified.correlationId,
  });

  const execute = dependencies.executeImport ?? executeImportQuery;
  const queryState = dependencies.queryState ?? executeImportStateQuery;
  let rawResult: unknown = undefined;
  let executionError: unknown = undefined;
  try {
    rawResult = await execute(query);
  } catch (error) {
    executionError = error;
  }

  const decoded =
    executionError === undefined
      ? decodeImportQueryResult(rawResult)
      : { type: "not_available" as const };

  let finalState: ImportStateRow | undefined;
  let postconditionError: unknown;
  try {
    const stateResult = await queryState(
      buildImportStateQuery({
        actorUserId,
        domain,
        username: verified.username,
        orderId: verified.orderId,
      }),
    );
    const stateDecoded = decodeImportStateResult(stateResult);
    if (stateDecoded.type === "decoded") {
      finalState = stateDecoded.row;
    } else {
      postconditionError = new Error(
        `Import state result was ${stateDecoded.type}.`,
      );
    }
  } catch (error) {
    postconditionError = error;
  }

  if (
    finalState &&
    importPostconditionSatisfied(finalState) &&
    finalState.site_id
  ) {
    if (decoded.type !== "decoded" || executionError !== undefined) {
      logImportDiagnostic({
        referenceId: createImportReferenceId(),
        phase:
          executionError === undefined ? "result_decode" : "database_import",
        error: executionError,
        correlationId: verified.correlationId,
        result: "postcondition_recovered",
      });
    }
    return {
      type:
        decoded.type === "decoded" &&
        decoded.row.outcome === "already_completed"
          ? "already_imported"
          : executionError !== undefined
            ? "already_imported"
            : "imported",
      siteId: finalState.site_id,
    };
  }

  if (executionError !== undefined) {
    if (isUniqueViolation(executionError)) {
      await writeImportAuditSafely({
        actorUserId,
        domain,
        operation: "hostinger_site_import_conflict",
        result: "FAILURE",
        metadata: { reason: "unique_violation" },
      });
      return {
        type: "single_site_conflict",
        reason: "unique_violation",
      };
    }
    return reportUnexpectedImportFailure({
      actorUserId,
      domain,
      phase: "database_import",
      error: executionError,
      correlationId: verified.correlationId,
    });
  }

  if (postconditionError !== undefined) {
    return reportUnexpectedImportFailure({
      actorUserId,
      domain,
      phase: "postcondition",
      error: postconditionError,
      correlationId: verified.correlationId,
    });
  }

  if (decoded.type !== "decoded") {
    return reportUnexpectedImportFailure({
      actorUserId,
      domain,
      phase: "result_decode",
      error: new Error(`Import result was ${decoded.type}.`),
      correlationId: verified.correlationId,
    });
  }

  if (
    decoded.row.outcome === "conflict" ||
    decoded.row.site_id === null
  ) {
    return {
      type: "single_site_conflict",
      reason: decoded.row.conflict_reason ?? "ambiguous_state",
    };
  }

  return reportUnexpectedImportFailure({
    actorUserId,
    domain,
    phase: "postcondition",
    error: new Error("Import result and final state were inconsistent."),
    correlationId: verified.correlationId,
  });
}

/**
 * Checks the authoritative database state before any new Hostinger request.
 * Partial state that the atomic statement can safely complete remains ready;
 * ambiguous or incompatible single-site state fails closed.
 */
export async function precheckConfiguredHostingerSite(
  actorUserId: string,
  dependencies: {
    queryState?: ImportStateQueryExecutor;
    configuredSite?: { domain: string; username: string };
  } = {},
): Promise<SiteImportPrecheckOutcome> {
  let configuredSite: { domain: string; username: string };
  try {
    configuredSite =
      dependencies.configuredSite ?? configuredSiteIdentity();
  } catch (error) {
    return reportUnexpectedImportFailure({
      actorUserId,
      domain: "configured-site",
      phase: "precheck",
      error,
    });
  }
  const domain = normalizeDomain(configuredSite.domain);
  const queryState = dependencies.queryState ?? executeImportStateQuery;

  let decoded: ReturnType<typeof decodeImportStateResult>;
  try {
    decoded = decodeImportStateResult(
      await queryState(
        buildImportStateQuery({
          actorUserId,
          domain,
          username: configuredSite.username,
        }),
      ),
    );
  } catch (error) {
    return reportUnexpectedImportFailure({
      actorUserId,
      domain,
      phase: "precheck",
      error,
    });
  }

  if (decoded.type !== "decoded") {
    return reportUnexpectedImportFailure({
      actorUserId,
      domain,
      phase: "precheck",
      error: new Error(`Precheck result was ${decoded.type}.`),
    });
  }

  const state = decoded.row;
  if (importPostconditionSatisfied(state) && state.site_id) {
    await writeImportAuditSafely({
      actorUserId,
      domain,
      siteId: state.site_id,
      operation: "hostinger_site_import_already_completed",
      result: "SUCCESS",
      metadata: { outcome: "already_imported", phase: "precheck" },
    });
    return { type: "already_imported", siteId: state.site_id };
  }

  const conflict = precheckConflictReason(state);
  if (conflict) {
    await writeImportAuditSafely({
      actorUserId,
      domain,
      siteId: state.site_id,
      operation: "hostinger_site_import_conflict",
      result: "FAILURE",
      metadata: { reason: conflict, phase: "precheck" },
    });
    return { type: "single_site_conflict", reason: conflict };
  }

  return { type: "ready" };
}

export function buildImportStateQuery(input: {
  actorUserId: string;
  domain: string;
  username: string;
  orderId?: string;
}) {
  const expectedOrderId = input.orderId ?? null;
  return sql`
    WITH target_sites AS MATERIALIZED (
      SELECT
        id,
        hostinger_username,
        hostinger_order_id,
        node_enabled,
        status
      FROM sites
      WHERE lower(primary_domain) = lower(${input.domain})
    )
    SELECT
      (SELECT min(id::text) FROM target_sites) AS site_id,
      (
        SELECT count(*)::int
        FROM target_sites
      ) AS target_site_count,
      (
        SELECT count(*)::int
        FROM sites
        WHERE lower(primary_domain) <> lower(${input.domain})
      ) AS other_site_count,
      (
        SELECT count(*)::int
        FROM target_sites
        WHERE hostinger_username = ${input.username}
      ) AS username_match_count,
      (
        SELECT count(*)::int
        FROM target_sites
        WHERE hostinger_username = ${input.username}
          AND status = 'VERIFIED'::site_status
          AND node_enabled = true
      ) AS verified_node_match_count,
      (
        SELECT count(*)::int
        FROM target_sites
        WHERE ${expectedOrderId}::text IS NULL
          OR hostinger_order_id = ${expectedOrderId}::text
      ) AS order_match_count,
      (
        SELECT count(*)::int
        FROM site_memberships membership
        INNER JOIN target_sites target
          ON target.id = membership.site_id
        WHERE membership.user_id = ${input.actorUserId}::uuid
          AND membership.role = 'ADMIN'::membership_role
      ) AS owner_admin_membership_count,
      (
        SELECT count(*)::int
        FROM site_memberships membership
        WHERE membership.user_id = ${input.actorUserId}::uuid
      ) AS owner_membership_count,
      (
        SELECT count(*)::int
        FROM hostinger_resource_bindings binding
        INNER JOIN target_sites target
          ON target.id = binding.site_id
        WHERE binding.resource_type = 'PRIMARY_DOMAIN'
          AND lower(binding.external_id) = lower(${input.domain})
      ) AS primary_binding_match_count,
      (
        SELECT count(*)::int
        FROM hostinger_resource_bindings binding
        INNER JOIN target_sites target
          ON target.id = binding.site_id
        WHERE binding.resource_type = 'PRIMARY_DOMAIN'
      ) AS primary_binding_count
  `;
}

export function buildAtomicImportQuery(input: {
  actorUserId: string;
  domain: string;
  username: string;
  orderId?: string;
  correlationId?: string;
}) {
  const targetHash = hashAuditIdentifier(input.domain);
  const safeCorrelationId =
    input.correlationId &&
    /^[A-Za-z0-9._:/-]{1,200}$/.test(input.correlationId)
      ? input.correlationId
      : null;

  return sql`
    WITH import_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(721347812) AS locked
    ),
    import_state AS MATERIALIZED (
      SELECT
        (
          SELECT id
          FROM sites
          WHERE lower(primary_domain) = lower(${input.domain})
          LIMIT 1
        ) AS same_site_id,
        EXISTS (
          SELECT 1
          FROM sites
          WHERE lower(primary_domain) <> lower(${input.domain})
        ) AS other_site_exists,
        EXISTS (
          SELECT 1
          FROM sites
          WHERE lower(primary_domain) = lower(${input.domain})
            AND hostinger_username <> ${input.username}
        ) AS username_conflict,
        EXISTS (
          SELECT 1
          FROM site_memberships memberships
          WHERE memberships.user_id = ${input.actorUserId}::uuid
            AND memberships.site_id <> COALESCE(
              (
                SELECT id
                FROM sites
                WHERE lower(primary_domain) = lower(${input.domain})
                LIMIT 1
              ),
              '00000000-0000-0000-0000-000000000000'::uuid
            )
        ) AS membership_conflict,
        EXISTS (
          SELECT 1
          FROM sites existing_site
          INNER JOIN site_memberships existing_membership
            ON existing_membership.site_id = existing_site.id
          WHERE lower(existing_site.primary_domain) = lower(${input.domain})
            AND existing_site.hostinger_username = ${input.username}
            AND existing_site.status = 'VERIFIED'::site_status
            AND existing_site.node_enabled = true
            AND existing_membership.user_id = ${input.actorUserId}::uuid
            AND existing_membership.role = 'ADMIN'::membership_role
        ) AS already_completed
      FROM import_lock
    ),
    decision AS MATERIALIZED (
      SELECT
        import_state.*,
        CASE
          WHEN membership_conflict THEN 'membership_conflict'
          WHEN other_site_exists THEN 'different_site'
          WHEN username_conflict THEN 'username_conflict'
          ELSE NULL
        END AS conflict_reason
      FROM import_state
    ),
    site_write AS (
      INSERT INTO sites (
        name,
        primary_domain,
        hostinger_username,
        hostinger_order_id,
        node_enabled,
        status,
        last_synced_at,
        created_at,
        updated_at
      )
      SELECT
        ${input.domain},
        ${input.domain},
        ${input.username},
        ${input.orderId ?? null},
        true,
        'VERIFIED'::site_status,
        now(),
        now(),
        now()
      FROM decision
      WHERE conflict_reason IS NULL
      ON CONFLICT ((lower(primary_domain))) DO UPDATE SET
        name = EXCLUDED.name,
        hostinger_username = EXCLUDED.hostinger_username,
        hostinger_order_id = EXCLUDED.hostinger_order_id,
        node_enabled = true,
        status = 'VERIFIED'::site_status,
        last_synced_at = now(),
        updated_at = now()
      WHERE sites.hostinger_username = EXCLUDED.hostinger_username
      RETURNING id
    ),
    membership_write AS (
      INSERT INTO site_memberships (site_id, user_id, role, created_at)
      SELECT
        site_write.id,
        ${input.actorUserId}::uuid,
        'ADMIN'::membership_role,
        now()
      FROM site_write
      ON CONFLICT (site_id, user_id) DO UPDATE SET
        role = 'ADMIN'::membership_role
      RETURNING site_id
    ),
    binding_write AS (
      INSERT INTO hostinger_resource_bindings (
        site_id,
        resource_type,
        external_id,
        metadata,
        last_verified_at
      )
      SELECT
        site_write.id,
        'PRIMARY_DOMAIN',
        ${input.domain},
        '{"source":"HOSTINGER_CONFIG"}'::jsonb,
        now()
      FROM site_write
      ON CONFLICT (site_id, resource_type, external_id) DO UPDATE SET
        last_verified_at = now()
      RETURNING site_id
    ),
    audit_write AS (
      INSERT INTO audit_events (
        actor_user_id,
        site_id,
        operation,
        target_type,
        target_identifier_hash,
        result,
        metadata,
        created_at
      )
      SELECT
        ${input.actorUserId}::uuid,
        site_write.id,
        CASE
          WHEN decision.already_completed
            THEN 'hostinger_site_import_already_completed'
          ELSE 'hostinger_site_imported'
        END,
        'site',
        ${targetHash},
        'SUCCESS'::audit_result,
        jsonb_strip_nulls(
          jsonb_build_object(
            'outcome',
            CASE
              WHEN decision.already_completed THEN 'already_completed'
              ELSE 'imported'
            END,
            'correlationId',
            ${safeCorrelationId}::text
          )
        ),
        now()
      FROM decision
      INNER JOIN site_write ON true
      INNER JOIN membership_write
        ON membership_write.site_id = site_write.id
      INNER JOIN binding_write
        ON binding_write.site_id = site_write.id
      WHERE decision.conflict_reason IS NULL

      UNION ALL

      SELECT
        ${input.actorUserId}::uuid,
        decision.same_site_id,
        'hostinger_site_import_conflict',
        'site',
        ${targetHash},
        'FAILURE'::audit_result,
        jsonb_build_object('reason', decision.conflict_reason),
        now()
      FROM decision
      WHERE decision.conflict_reason IS NOT NULL
      RETURNING site_id
    )
    SELECT
      CASE
        WHEN decision.conflict_reason IS NOT NULL THEN 'conflict'
        WHEN decision.already_completed THEN 'already_completed'
        ELSE 'imported'
      END AS outcome,
      COALESCE(audit_write.site_id, decision.same_site_id) AS site_id,
      decision.conflict_reason
    FROM decision
    INNER JOIN audit_write ON true
  `;
}

async function executeImportQuery(query: SQL) {
  return await getDb().execute(query);
}

async function executeImportStateQuery(query: SQL) {
  return await getDb().execute(query);
}

export type ImportResultDecode =
  | { type: "decoded"; row: ImportQueryRow }
  | { type: "zero_rows" }
  | { type: "malformed" };

export function decodeImportQueryResult(
  result: unknown,
): ImportResultDecode {
  const rows = documentedResultRows(result);
  if (!rows) return { type: "malformed" };
  if (rows.length === 0) return { type: "zero_rows" };
  if (rows.length !== 1) return { type: "malformed" };
  const parsed = importQueryRowSchema.safeParse(rows[0]);
  return parsed.success
    ? { type: "decoded", row: parsed.data }
    : { type: "malformed" };
}

function decodeImportStateResult(
  result: unknown,
):
  | { type: "decoded"; row: ImportStateRow }
  | { type: "zero_rows" }
  | { type: "malformed" } {
  const rows = documentedResultRows(result);
  if (!rows) return { type: "malformed" };
  if (rows.length === 0) return { type: "zero_rows" };
  if (rows.length !== 1) return { type: "malformed" };
  const parsed = importStateRowSchema.safeParse(rows[0]);
  return parsed.success
    ? { type: "decoded", row: parsed.data }
    : { type: "malformed" };
}

/**
 * drizzle-orm/neon-http 0.45 executes raw SQL with `fullResults: true`, so the
 * production shape is `{ rows, fields, command, rowCount, rowAsArray }`.
 * Direct row arrays are also accepted for the documented Neon non-full-result
 * form and for isolated executors used by tests.
 */
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

function importPostconditionSatisfied(state: ImportStateRow) {
  return (
    state.target_site_count === 1 &&
    state.other_site_count === 0 &&
    state.username_match_count === 1 &&
    state.verified_node_match_count === 1 &&
    state.order_match_count === 1 &&
    state.owner_admin_membership_count === 1 &&
    state.owner_membership_count === 1 &&
    state.primary_binding_match_count === 1 &&
    state.primary_binding_count === 1
  );
}

function precheckConflictReason(
  state: ImportStateRow,
): SiteImportConflictReason | null {
  if (state.other_site_count > 0) return "different_site";
  if (state.target_site_count > 1 || state.owner_membership_count > 1) {
    return "ambiguous_state";
  }
  if (
    state.target_site_count === 1 &&
    state.username_match_count !== 1
  ) {
    return "username_conflict";
  }
  if (
    state.primary_binding_count > 1 ||
    (state.primary_binding_count === 1 &&
      state.primary_binding_match_count !== 1)
  ) {
    return "ambiguous_state";
  }
  if (state.target_site_count === 0 && state.owner_membership_count > 0) {
    return "membership_conflict";
  }
  return null;
}

function configuredSiteIdentity() {
  const configuration = getHostingerConfigurationState();
  const env = getHostingerEnv();
  if (!configuration.configured || !env.HOSTINGER_ACCOUNT_USERNAME) {
    throw new AppError(
      "HOSTINGER_ERROR",
      "Hostinger is not configured correctly.",
      503,
    );
  }
  return {
    domain: configuration.domain,
    username: env.HOSTINGER_ACCOUNT_USERNAME,
  };
}

function createImportReferenceId() {
  return randomBytes(6).toString("hex").toUpperCase();
}

export async function reportUnexpectedImportFailure(input: {
  actorUserId: string;
  domain: string;
  phase: Exclude<ImportFailurePhase, "redirect">;
  error: unknown;
  correlationId?: string;
}): Promise<
  Extract<HostingerSiteImportOutcome, { type: "persistence_failed" }>
> {
  const referenceId = createImportReferenceId();
  const diagnostic = logImportDiagnostic({
    referenceId,
    phase: input.phase,
    error: input.error,
    correlationId: input.correlationId,
    result: "failure",
  });
  await writeImportAuditSafely({
    actorUserId: input.actorUserId,
    domain: input.domain,
    operation: "hostinger_site_import_failed",
    result: "FAILURE",
    metadata: diagnostic,
  });
  return {
    type: "persistence_failed",
    referenceId,
    phase: input.phase,
  };
}

export function logRecoveredImportIssue(input: {
  phase: ImportFailurePhase;
  error: unknown;
  correlationId?: string;
}) {
  logImportDiagnostic({
    referenceId: createImportReferenceId(),
    phase: input.phase,
    error: input.error,
    correlationId: input.correlationId,
    result: "recovered",
  });
}

function logImportDiagnostic(input: {
  referenceId: string;
  phase: ImportFailurePhase;
  error?: unknown;
  correlationId?: string;
  result: "failure" | "recovered" | "postcondition_recovered";
}) {
  const database = databaseErrorMetadata(input.error);
  const diagnostic = {
    referenceId: input.referenceId,
    phase: input.phase,
    postgresCode: database.postgresCode,
    constraint: database.constraint,
    errorType: database.errorType,
    correlationId: sanitizeCorrelationId(input.correlationId),
    result: input.result,
  };
  emitStructuredDiagnostic(
    input.result === "failure" ? "error" : "warn",
    "hostinger_site_import_diagnostic",
    diagnostic,
  );
  return diagnostic;
}

function databaseErrorMetadata(error: unknown) {
  const chain = safeErrorCauseChain(error);
  const postgresCode = chain
    .map((record) => record.code)
    .find(
      (code): code is string =>
        typeof code === "string" && /^[A-Z0-9]{5}$/.test(code),
    );
  const constraint = chain
    .map((record) => record.constraint)
    .find(
      (value): value is string =>
        typeof value === "string" &&
        SAFE_DATABASE_CONSTRAINTS.has(value),
    );
  const candidateType = error instanceof Error ? error.name : typeof error;
  const errorType = SAFE_ERROR_TYPES.has(candidateType)
    ? candidateType
    : error instanceof Error
      ? "Error"
      : "UnknownError";
  return { postgresCode, constraint, errorType };
}

function safeErrorCauseChain(error: unknown) {
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) {
      break;
    }
    visited.add(current);
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }

  return chain;
}

const MAX_ERROR_CAUSE_DEPTH = 4;

const SAFE_DATABASE_CONSTRAINTS = new Set([
  "sites_primary_domain_unique",
  "site_memberships_site_user_unique",
  "resource_bindings_site_type_external_unique",
  "site_memberships_site_id_sites_id_fk",
  "site_memberships_user_id_users_id_fk",
  "hostinger_resource_bindings_site_id_sites_id_fk",
  "audit_events_actor_user_id_users_id_fk",
  "audit_events_site_id_sites_id_fk",
]);

const SAFE_ERROR_TYPES = new Set([
  "Error",
  "AppError",
  "TypeError",
  "RangeError",
  "AbortError",
  "PostgresError",
]);

function sanitizeCorrelationId(value: unknown) {
  return typeof value === "string" &&
    /^[A-Za-z0-9._:/-]{1,200}$/.test(value) &&
    !value.includes("://")
    ? value
    : undefined;
}

async function writeImportAuditSafely(input: {
  actorUserId: string;
  domain: string;
  siteId?: string | null;
  operation: string;
  result: "SUCCESS" | "FAILURE";
  metadata?: Record<string, unknown>;
}) {
  try {
    await writeAuditEvent({
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      operation: input.operation,
      targetType: "site",
      targetIdentifier: input.domain,
      result: input.result,
      metadata: input.metadata,
    });
  } catch {
    // The primary operation outcome must not be replaced by a secondary audit
    // write failure. The main diagnostic already carries the reference ID.
  }
}

function isUniqueViolation(error: unknown) {
  return databaseErrorMetadata(error).postgresCode === "23505";
}
