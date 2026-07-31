import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { hostingerOperations } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import { AppError } from "@/lib/errors";
import {
  createHostingerClient,
  type HostingerClient,
} from "./client";
import {
  claimHostingerOperation,
  finishHostingerOperation,
  type HostingerOperationClaim,
} from "./operation-store";
import {
  createDiagnosticReferenceId,
  reportHostingerOperationDiagnostic,
  type HostingerDiagnosticPhase,
} from "./operation-diagnostic";
import {
  assertHostingerSiteAccess,
  type HostingerSiteCapability,
} from "./permissions";

export const CACHE_COOLDOWN_SECONDS = 15;
export const CACHE_CLEAR_OPERATION = "site.cache.clear";
export const CACHE_ENABLE_OPERATION = "site.cache.enable";
export const CACHE_DISABLE_OPERATION = "site.cache.disable";
export const CACHELESS_ENABLE_OPERATION = "site.cacheless.enable";
export const CACHELESS_DISABLE_OPERATION = "site.cacheless.disable";

const cacheOperationTypes = [
  CACHE_CLEAR_OPERATION,
  CACHE_ENABLE_OPERATION,
  CACHE_DISABLE_OPERATION,
  CACHELESS_ENABLE_OPERATION,
  CACHELESS_DISABLE_OPERATION,
] as const;

type CacheAccessContext = {
  user: { id: string };
  site: SiteAccessRecord;
};

type CacheClient = Pick<
  HostingerClient,
  | "clearWebsiteCache"
  | "toggleWebsiteCache"
  | "toggleWebsiteCachelessMode"
>;

type CacheDependencies = {
  client?: CacheClient;
  claimOperation?: typeof claimHostingerOperation;
  finishOperation?: typeof finishHostingerOperation;
  audit?: typeof writeAuditEvent;
  createReferenceId?: () => string;
};

export async function clearCacheForSite(
  current: CacheAccessContext,
  idempotencyKey: string,
  dependencies: CacheDependencies = {},
) {
  return await performCacheMutation(
    current,
    {
      capability: "site.cache.clear",
      operationType: CACHE_CLEAR_OPERATION,
      phase: "cache_clear",
      idempotencyKey,
      mutate: async (client) =>
        await client.clearWebsiteCache(
          current.site.hostingerUsername,
          current.site.primaryDomain,
        ),
    },
    dependencies,
  );
}

export async function toggleCacheForSite(
  current: CacheAccessContext,
  enabled: boolean,
  idempotencyKey: string,
  dependencies: CacheDependencies = {},
) {
  return await performCacheMutation(
    current,
    {
      capability: "site.cache.toggle",
      operationType: enabled
        ? CACHE_ENABLE_OPERATION
        : CACHE_DISABLE_OPERATION,
      phase: "cache_toggle",
      idempotencyKey,
      mutate: async (client) =>
        await client.toggleWebsiteCache(
          current.site.hostingerUsername,
          current.site.primaryDomain,
          enabled,
        ),
    },
    dependencies,
  );
}

export async function toggleCachelessModeForSite(
  current: CacheAccessContext,
  enabled: boolean,
  idempotencyKey: string,
  dependencies: CacheDependencies = {},
) {
  return await performCacheMutation(
    current,
    {
      capability: "site.cacheless.toggle",
      operationType: enabled
        ? CACHELESS_ENABLE_OPERATION
        : CACHELESS_DISABLE_OPERATION,
      phase: "cacheless_toggle",
      idempotencyKey,
      mutate: async (client) =>
        await client.toggleWebsiteCachelessMode(
          current.site.hostingerUsername,
          current.site.primaryDomain,
          enabled,
        ),
    },
    dependencies,
  );
}

export async function getLastCacheRequests(siteId: string) {
  const rows = await getDb()
    .select({
      operationType: hostingerOperations.operationType,
      status: hostingerOperations.status,
      createdAt: hostingerOperations.createdAt,
    })
    .from(hostingerOperations)
    .where(
      and(
        eq(hostingerOperations.siteId, siteId),
        inArray(
          hostingerOperations.operationType,
          [...cacheOperationTypes],
        ),
      ),
    )
    .orderBy(desc(hostingerOperations.createdAt))
    .limit(50);
  return {
    clear: latest(rows, [CACHE_CLEAR_OPERATION]),
    cache: latest(rows, [
      CACHE_ENABLE_OPERATION,
      CACHE_DISABLE_OPERATION,
    ]),
    cacheless: latest(rows, [
      CACHELESS_ENABLE_OPERATION,
      CACHELESS_DISABLE_OPERATION,
    ]),
  };
}

type CacheMutation = {
  capability: HostingerSiteCapability;
  operationType: string;
  phase: HostingerDiagnosticPhase;
  idempotencyKey: string;
  mutate: (
    client: CacheClient,
  ) => Promise<{ accepted: true; correlationId?: string }>;
};

async function performCacheMutation(
  current: CacheAccessContext,
  mutation: CacheMutation,
  dependencies: CacheDependencies,
) {
  assertHostingerSiteAccess(
    current.site.membershipRole,
    mutation.capability,
  );
  const startedAt = Date.now();
  const referenceId =
    dependencies.createReferenceId?.() ??
    createDiagnosticReferenceId();
  const idempotencyKeyHash = hash(mutation.idempotencyKey.toLowerCase());
  const claim = await (
    dependencies.claimOperation ?? claimHostingerOperation
  )({
    siteId: current.site.siteId,
    actorUserId: current.user.id,
    operationType: mutation.operationType,
    resourceKeyHash: hash("site-cache"),
    idempotencyKeyHash,
    referenceId,
    cooldownSeconds: CACHE_COOLDOWN_SECONDS,
  });
  const audit = dependencies.audit ?? writeAuditEvent;
  if (claim.kind !== "claimed") {
    await auditClaimConflict(current, mutation, claim, audit);
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: mutation.phase,
      upstreamStatus: 409,
      operationType: mutation.operationType,
      idempotencyStatus:
        claim.kind === "duplicate" ? "duplicate" : "blocked",
      result:
        claim.kind === "duplicate" &&
        claim.operation.status === "SUCCEEDED"
          ? "success"
          : "denied",
      startedAt,
    });
    if (
      claim.kind === "duplicate" &&
      claim.operation.status === "SUCCEEDED"
    ) {
      return outcome(claim, "replayed");
    }
    throw new AppError(
      "CONFLICT",
      claim.kind === "blocked" && claim.reason === "cooldown"
        ? "Wait briefly before requesting another cache operation."
        : "Another cache operation is already in progress.",
      409,
      undefined,
      claim.operation.referenceId,
      claim.kind === "blocked" && claim.reason === "cooldown"
        ? CACHE_COOLDOWN_SECONDS
        : 5,
    );
  }

  await safeAudit(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${mutation.operationType}_requested`,
    targetType: "site",
    targetIdentifier: current.site.siteId,
    result: "SUCCESS",
    metadata: {
      capability: mutation.capability,
      referenceId: claim.operation.referenceId,
      idempotencyStatus: "claimed",
    },
  });

  let result: { accepted: true; correlationId?: string };
  try {
    result = await mutation.mutate(
      dependencies.client ?? createHostingerClient(),
    );
  } catch (error) {
    const controlled = controlledError(
      error,
      claim.operation.referenceId,
    );
    await safeFinish(
      dependencies.finishOperation ?? finishHostingerOperation,
      {
        siteId: current.site.siteId,
        operationType: mutation.operationType,
        idempotencyKeyHash,
        status: "FAILED",
        correlationId: controlled.correlationId,
      },
    );
    await safeAudit(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: `hostinger_${mutation.operationType}_failed`,
      targetType: "site",
      targetIdentifier: current.site.siteId,
      result: "FAILURE",
      metadata: {
        capability: mutation.capability,
        referenceId: claim.operation.referenceId,
        correlationId: controlled.correlationId,
        status: controlled.status,
      },
    });
    if (controlled.code === "RATE_LIMITED") {
      await safeAudit(audit, {
        actorUserId: current.user.id,
        siteId: current.site.siteId,
        operation: "hostinger_rate_limited",
        targetType: "site",
        targetIdentifier: current.site.siteId,
        result: "FAILURE",
        metadata: {
          capability: mutation.capability,
          referenceId: claim.operation.referenceId,
          status: controlled.status,
        },
      });
    }
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: mutation.phase,
      upstreamStatus: controlled.status,
      correlationId: controlled.correlationId,
      operationType: mutation.operationType,
      idempotencyStatus: "failed",
      result: "failure",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
      ],
    });
    throw controlled;
  }

  const correlationId = safeCorrelationId(
    result.correlationId,
    current,
  );
  const finished = await safeFinish(
    dependencies.finishOperation ?? finishHostingerOperation,
    {
      siteId: current.site.siteId,
      operationType: mutation.operationType,
      idempotencyKeyHash,
      status: "SUCCEEDED",
      correlationId,
    },
  );
  if (!finished) {
    await safeAudit(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: `hostinger_${mutation.operationType}_failed`,
      targetType: "site",
      targetIdentifier: current.site.siteId,
      result: "FAILURE",
      metadata: {
        capability: mutation.capability,
        referenceId: claim.operation.referenceId,
        phase: "success_persistence",
      },
    });
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: mutation.phase,
      upstreamStatus: 503,
      correlationId,
      operationType: mutation.operationType,
      idempotencyStatus: "failed",
      result: "failure",
      startedAt,
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Hostinger accepted the cache request, but its local result could not be recorded. Do not retry.",
      503,
      correlationId,
      claim.operation.referenceId,
    );
  }
  await safeAudit(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${mutation.operationType}_completed`,
    targetType: "site",
    targetIdentifier: current.site.siteId,
    result: "SUCCESS",
    metadata: {
      capability: mutation.capability,
      referenceId: claim.operation.referenceId,
      correlationId,
      idempotencyStatus: "completed",
    },
  });
  reportHostingerOperationDiagnostic({
    referenceId: claim.operation.referenceId,
    phase: mutation.phase,
    upstreamStatus: 200,
    correlationId,
    operationType: mutation.operationType,
    idempotencyStatus: "completed",
    result: "accepted",
    startedAt,
    forbiddenValues: [
      current.site.hostingerUsername,
      current.site.primaryDomain,
    ],
  });
  return outcome(claim, "created");
}

async function auditClaimConflict(
  current: CacheAccessContext,
  mutation: CacheMutation,
  claim: Exclude<HostingerOperationClaim, { kind: "claimed" }>,
  audit: typeof writeAuditEvent,
) {
  await safeAudit(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation:
      claim.kind === "duplicate"
        ? "hostinger_cache_operation_duplicate"
        : "hostinger_cache_operation_blocked",
    targetType: "site",
    targetIdentifier: current.site.siteId,
    result:
      claim.kind === "duplicate" &&
      claim.operation.status === "SUCCEEDED"
        ? "SUCCESS"
        : "DENIED",
    metadata: {
      capability: mutation.capability,
      referenceId: claim.operation.referenceId,
      idempotencyStatus:
        claim.kind === "blocked"
          ? claim.reason
          : claim.operation.status,
    },
  });
}

function latest(
  rows: {
    operationType: string;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    createdAt: Date;
  }[],
  operationTypes: string[],
) {
  const row = rows.find((item) =>
    operationTypes.includes(item.operationType),
  );
  return row
    ? {
        operationType: row.operationType,
        status: row.status,
        requestedAt: row.createdAt.toISOString(),
      }
    : undefined;
}

function outcome(
  claim: HostingerOperationClaim,
  idempotencyStatus: "created" | "replayed",
) {
  return {
    accepted: true as const,
    referenceId: claim.operation.referenceId,
    idempotencyStatus,
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeCorrelationId(
  value: unknown,
  current: CacheAccessContext,
) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    value.includes("://")
  ) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return [
    current.site.hostingerUsername,
    current.site.primaryDomain,
  ].some((item) => normalized.includes(item.toLowerCase()))
    ? undefined
    : value;
}

function controlledError(error: unknown, referenceId: string) {
  return error instanceof AppError
    ? new AppError(
        error.code,
        error.status === 504
          ? "The Hostinger cache result is ambiguous. Do not submit a different cache operation immediately."
          : error.message,
        error.status,
        error.correlationId,
        referenceId,
        error.retryAfterSeconds,
      )
    : new AppError(
        "HOSTINGER_ERROR",
        "The Hostinger cache request could not be completed.",
        503,
        undefined,
        referenceId,
      );
}

async function safeFinish(
  finish: typeof finishHostingerOperation,
  input: Parameters<typeof finishHostingerOperation>[0],
) {
  try {
    return await finish(input);
  } catch {
    return false;
  }
}

async function safeAudit(
  audit: typeof writeAuditEvent,
  event: Parameters<typeof writeAuditEvent>[0],
) {
  try {
    await audit(event);
  } catch {
    // Never repeat an external mutation because audit persistence failed.
  }
}
