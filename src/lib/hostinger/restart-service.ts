import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import { writeAuditEvent } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  createHostingerClient,
  type HostingerClient,
} from "./client";
import {
  claimHostingerOperation,
  finishHostingerOperation,
  NODE_RESTART_COOLDOWN_SECONDS,
  NODE_RESTART_OPERATION,
  type HostingerOperationClaim,
} from "./operation-store";
import { assertHostingerSiteAccess } from "./permissions";

export type RestartAccessContext = {
  user: { id: string };
  site: SiteAccessRecord;
};

type RestartServiceDependencies = {
  client?: Pick<HostingerClient, "restartNodeServer">;
  claimOperation?: typeof claimHostingerOperation;
  finishOperation?: typeof finishHostingerOperation;
  audit?: typeof writeAuditEvent;
  now?: () => Date;
  createReferenceId?: () => string;
};

export type NodeRestartOutcome = {
  restarted: true;
  referenceId: string;
  idempotencyStatus: "created" | "replayed";
  cooldownEndsAt: string;
};

export async function restartNodeServerForSite(
  current: RestartAccessContext,
  idempotencyKey: string,
  dependencies: RestartServiceDependencies = {},
): Promise<NodeRestartOutcome> {
  assertHostingerSiteAccess(
    current.site.membershipRole,
    NODE_RESTART_OPERATION,
  );
  const parsedKey = z.string().uuid().safeParse(idempotencyKey);
  if (!parsedKey.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A valid idempotency key is required.",
      400,
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().getTime();
  const referenceId =
    dependencies.createReferenceId?.() ??
    randomBytes(6).toString("hex");
  const idempotencyKeyHash = createHash("sha256")
    .update(parsedKey.data.toLowerCase())
    .digest("hex");
  const claimOperation =
    dependencies.claimOperation ?? claimHostingerOperation;
  const audit = dependencies.audit ?? writeAuditEvent;

  let claim: HostingerOperationClaim;
  try {
    claim = await claimOperation({
      siteId: current.site.siteId,
      actorUserId: current.user.id,
      operationType: NODE_RESTART_OPERATION,
      idempotencyKeyHash,
      referenceId,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logRestartDiagnostic(referenceId, "claim", error);
    throw new AppError(
      "INTERNAL_ERROR",
      "The restart request could not be recorded.",
      503,
      undefined,
      referenceId,
    );
  }

  if (claim.kind !== "claimed") {
    return await handleUnclaimedOperation(current, claim, audit, now());
  }

  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_node_restart_requested",
    targetType: "hostinger_operation",
    targetIdentifier: claim.operation.referenceId,
    result: "SUCCESS",
    metadata: {
      capability: NODE_RESTART_OPERATION,
      referenceId: claim.operation.referenceId,
      idempotencyStatus: "claimed",
    },
  });

  const client = dependencies.client ?? createHostingerClient();
  const finishOperation =
    dependencies.finishOperation ?? finishHostingerOperation;
  let result: Awaited<ReturnType<typeof client.restartNodeServer>>;
  try {
    result = await client.restartNodeServer(
      current.site.hostingerUsername,
      current.site.primaryDomain,
    );
  } catch (error) {
    const controlled = controlledRestartError(
      error,
      claim.operation.referenceId,
      [
        current.site.hostingerUsername,
        current.site.primaryDomain,
      ],
    );
    try {
      await finishOperation({
        siteId: current.site.siteId,
        operationType: NODE_RESTART_OPERATION,
        idempotencyKeyHash,
        status: "FAILED",
        correlationId: controlled.correlationId,
      });
    } catch (persistenceError) {
      logRestartDiagnostic(
        claim.operation.referenceId,
        "failure_persistence",
        persistenceError,
      );
    }
    await auditRestartFailure(
      audit,
      current,
      controlled,
      claim.operation.referenceId,
      approximateDuration(startedAt, now()),
    );
    throw controlled;
  }

  const correlationId = sanitizeCorrelationId(result.correlationId, [
    current.site.hostingerUsername,
    current.site.primaryDomain,
  ]);
  let completed = false;
  try {
    completed = await finishOperation({
      siteId: current.site.siteId,
      operationType: NODE_RESTART_OPERATION,
      idempotencyKeyHash,
      status: "SUCCEEDED",
      correlationId,
    });
  } catch (error) {
    logRestartDiagnostic(
      claim.operation.referenceId,
      "success_persistence",
      error,
    );
  }
  if (!completed) {
    const error = new AppError(
      "INTERNAL_ERROR",
      "The restart was accepted but its result could not be recorded. Do not retry this request.",
      503,
      correlationId,
      claim.operation.referenceId,
      NODE_RESTART_COOLDOWN_SECONDS,
    );
    await auditRestartFailure(
      audit,
      current,
      error,
      claim.operation.referenceId,
      approximateDuration(startedAt, now()),
      "success_persistence",
    );
    throw error;
  }

  const durationMs = approximateDuration(startedAt, now());
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_node_restart_completed",
    targetType: "hostinger_operation",
    targetIdentifier: claim.operation.referenceId,
    result: "SUCCESS",
    metadata: {
      capability: NODE_RESTART_OPERATION,
      referenceId: claim.operation.referenceId,
      correlationId,
      idempotencyStatus: "completed",
      durationMs,
    },
  });

  return operationSuccess(claim.operation, "created");
}

async function handleUnclaimedOperation(
  current: RestartAccessContext,
  claim: Exclude<HostingerOperationClaim, { kind: "claimed" }>,
  audit: typeof writeAuditEvent,
  now: Date,
): Promise<NodeRestartOutcome> {
  if (claim.kind === "duplicate") {
    await writeAuditSafely(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_node_restart_duplicate",
      targetType: "hostinger_operation",
      targetIdentifier: claim.operation.referenceId,
      result:
        claim.operation.status === "SUCCEEDED" ? "SUCCESS" : "DENIED",
      metadata: {
        capability: NODE_RESTART_OPERATION,
        referenceId: claim.operation.referenceId,
        idempotencyStatus: claim.operation.status,
      },
    });
    if (claim.operation.status === "SUCCEEDED") {
      return operationSuccess(claim.operation, "replayed");
    }
    if (claim.operation.status === "IN_PROGRESS") {
      throw operationConflict(
        "This restart request is already in progress.",
        claim.operation.referenceId,
        5,
      );
    }
    throw operationConflict(
      "This restart request already failed and will not be sent again.",
      claim.operation.referenceId,
      cooldownRemainingSeconds(claim.operation.createdAt, now) ||
        undefined,
    );
  }

  const retryAfterSeconds =
    claim.reason === "in_progress"
      ? 5
      : Math.max(
          1,
          cooldownRemainingSeconds(claim.operation.createdAt, now),
        );
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_node_restart_blocked",
    targetType: "hostinger_operation",
    targetIdentifier: claim.operation.referenceId,
    result: "DENIED",
    metadata: {
      capability: NODE_RESTART_OPERATION,
      referenceId: claim.operation.referenceId,
      idempotencyStatus: claim.reason,
      retryAfterSeconds,
    },
  });
  throw operationConflict(
    claim.reason === "in_progress"
      ? "A restart is already in progress for this site."
      : "A restart was recently requested for this site.",
    claim.operation.referenceId,
    retryAfterSeconds,
  );
}

function operationSuccess(
  operation: HostingerOperationClaim["operation"],
  idempotencyStatus: NodeRestartOutcome["idempotencyStatus"],
): NodeRestartOutcome {
  return {
    restarted: true,
    referenceId: operation.referenceId,
    idempotencyStatus,
    cooldownEndsAt: new Date(
      operation.createdAt.getTime() +
        NODE_RESTART_COOLDOWN_SECONDS * 1_000,
    ).toISOString(),
  };
}

function operationConflict(
  message: string,
  referenceId: string,
  retryAfterSeconds?: number,
) {
  return new AppError(
    "CONFLICT",
    message,
    409,
    undefined,
    referenceId,
    retryAfterSeconds,
  );
}

function cooldownRemainingSeconds(createdAt: Date, now: Date) {
  const remaining =
    createdAt.getTime() +
    NODE_RESTART_COOLDOWN_SECONDS * 1_000 -
    now.getTime();
  return Math.max(0, Math.ceil(remaining / 1_000));
}

function controlledRestartError(
  error: unknown,
  referenceId: string,
  forbiddenValues: string[],
) {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.message,
      error.status,
      sanitizeCorrelationId(error.correlationId, forbiddenValues),
      referenceId,
      error.retryAfterSeconds ?? NODE_RESTART_COOLDOWN_SECONDS,
    );
  }
  return new AppError(
    "HOSTINGER_ERROR",
    "The Hostinger restart could not be completed.",
    503,
    undefined,
    referenceId,
    NODE_RESTART_COOLDOWN_SECONDS,
  );
}

function sanitizeCorrelationId(
  value: unknown,
  forbiddenValues: string[] = [],
) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    value.includes("://")
  ) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return forbiddenValues.some(
    (forbidden) =>
      forbidden.length > 0 &&
      normalized.includes(forbidden.toLowerCase()),
  )
    ? undefined
    : value;
}

async function auditRestartFailure(
  audit: typeof writeAuditEvent,
  current: RestartAccessContext,
  error: AppError,
  referenceId: string,
  durationMs: number,
  phase = "hostinger_request",
) {
  const metadata = {
    capability: NODE_RESTART_OPERATION,
    referenceId,
    correlationId: error.correlationId,
    errorCode: error.code,
    status: error.status,
    idempotencyStatus: "failed",
    phase,
    durationMs,
  };
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_node_restart_failed",
    targetType: "hostinger_operation",
    targetIdentifier: referenceId,
    result: "FAILURE",
    metadata,
  });
  if (error.code === "RATE_LIMITED") {
    await writeAuditSafely(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_rate_limited",
      targetType: "hostinger_operation",
      targetIdentifier: referenceId,
      result: "FAILURE",
      metadata,
    });
  }
}

function approximateDuration(startedAt: number, now: Date) {
  return Math.max(
    0,
    Math.round((now.getTime() - startedAt) / 10) * 10,
  );
}

function logRestartDiagnostic(
  referenceId: string,
  phase: "claim" | "failure_persistence" | "success_persistence",
  error: unknown,
) {
  const errorType =
    error instanceof Error &&
    [
      "DatabaseError",
      "DrizzleError",
      "DrizzleQueryError",
      "Error",
      "NeonDbError",
      "PostgresError",
    ].includes(error.name)
      ? error.name
      : "UnknownError";
  console.error("hostinger_node_restart_diagnostic", {
    referenceId,
    phase,
    errorType,
    result: "failure",
  });
}

async function writeAuditSafely(
  audit: typeof writeAuditEvent,
  event: Parameters<typeof writeAuditEvent>[0],
) {
  try {
    await audit(event);
  } catch {
    // Audit persistence must not cause a duplicate external mutation.
  }
}
