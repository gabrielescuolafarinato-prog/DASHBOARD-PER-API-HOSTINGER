import "server-only";
import { sql, type SQL } from "drizzle-orm";
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

export type VerifiedConfiguredSite = {
  domain: string;
  username: string;
  orderId?: string;
  siteStatus: "VERIFIED";
  nodeEnabled: true;
  correlationId?: string;
};

export type SiteImportResult = {
  outcome: "imported" | "already_completed";
  siteId: string;
};

type ImportQueryRow = {
  outcome: "imported" | "already_completed" | "conflict";
  site_id: string | null;
  conflict_reason: string | null;
};

export type ImportQueryExecutor = (query: SQL) => Promise<unknown>;

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
          "HOSTINGER_ERROR",
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
  execute: ImportQueryExecutor = executeImportQuery,
): Promise<SiteImportResult> {
  const domain = normalizeDomain(verified.domain);
  if (!verified.nodeEnabled || verified.siteStatus !== "VERIFIED") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only a verified Node.js site can be imported.",
      400,
    );
  }

  const query = buildAtomicImportQuery({
    actorUserId,
    domain,
    username: verified.username,
    orderId: verified.orderId,
    correlationId: verified.correlationId,
  });

  let rawResult: unknown;
  try {
    rawResult = await execute(query);
  } catch (error) {
    if (isUniqueViolation(error)) {
      await writeAuditEvent({
        actorUserId,
        operation: "hostinger_site_import_conflict",
        targetType: "site",
        targetIdentifier: domain,
        result: "FAILURE",
        metadata: { reason: "unique_violation" },
      });
      throw new AppError(
        "CONFLICT",
        "The site import conflicts with an existing single-site record.",
        409,
      );
    }
    throw error;
  }

  const [row] = resultRows(rawResult);
  if (!row || !isImportQueryRow(row)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "The atomic site import did not return a valid result.",
      500,
    );
  }
  if (row.outcome === "conflict" || !row.site_id) {
    throw new AppError(
      "CONFLICT",
      conflictMessage(row.conflict_reason),
      409,
    );
  }
  return { outcome: row.outcome, siteId: row.site_id };
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
            AND existing_site.status = 'VERIFIED'
            AND existing_site.node_enabled = true
            AND existing_membership.user_id = ${input.actorUserId}::uuid
            AND existing_membership.role = 'ADMIN'
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
        'VERIFIED',
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
        status = 'VERIFIED',
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
        'ADMIN',
        now()
      FROM site_write
      ON CONFLICT (site_id, user_id) DO UPDATE SET
        role = 'ADMIN'
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
        'SUCCESS',
        jsonb_strip_nulls(
          jsonb_build_object(
            'outcome',
            CASE
              WHEN decision.already_completed THEN 'already_completed'
              ELSE 'imported'
            END,
            'correlationId',
            ${safeCorrelationId}
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
        'FAILURE',
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

function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function isImportQueryRow(value: unknown): value is ImportQueryRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.outcome === "imported" ||
      row.outcome === "already_completed" ||
      row.outcome === "conflict") &&
    (typeof row.site_id === "string" || row.site_id === null) &&
    (typeof row.conflict_reason === "string" ||
      row.conflict_reason === null)
  );
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

function conflictMessage(reason: string | null) {
  if (reason === "different_site") {
    return "Another site record already occupies the single-site workspace.";
  }
  if (reason === "membership_conflict") {
    return "The OWNER already has an incompatible site membership.";
  }
  if (reason === "username_conflict") {
    return "The existing site belongs to a different hosting username.";
  }
  return "The site import conflicts with the existing workspace state.";
}
