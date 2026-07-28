import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteBuilds } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import { AppError } from "@/lib/errors";
import {
  createHostingerClient,
  type HostingerClient,
  type NodeBuildPage,
  type NodeBuildState,
  type NodeBuildSummary,
} from "./client";
import { buildMigrationRequiredError } from "./build-schema-diagnostic";
import { sanitizeBuildLogs } from "./log-sanitizer";
import {
  assertHostingerSiteAccess,
  type HostingerSiteCapability,
} from "./permissions";

export type BuildAccessContext = {
  user: { id: string };
  site: SiteAccessRecord;
};

export type BoundSiteBuild = {
  uuid: string;
  state: NodeBuildState;
  origin?: string;
  createdAt?: string;
  updatedAt?: string;
};

type BuildServiceDependencies = {
  client?: Pick<HostingerClient, "listNodeBuilds" | "getNodeBuildLogs">;
  syncBuilds?: typeof syncSiteBuilds;
  findBuild?: typeof findSiteBuild;
  audit?: typeof writeAuditEvent;
};

export async function listBuildsForSite(
  current: BuildAccessContext,
  pagination: { page: number; perPage: number },
  dependencies: BuildServiceDependencies = {},
) {
  assertPermission(current.site, "node.builds.list");
  const client = dependencies.client ?? createHostingerClient();
  const audit = dependencies.audit ?? writeAuditEvent;
  let page: NodeBuildPage;
  try {
    page = await client.listNodeBuilds(
      current.site.hostingerUsername,
      current.site.primaryDomain,
      pagination,
    );
  } catch (error) {
    await auditHostingerError(audit, current, "node_builds_list", error);
    throw error;
  }

  const sync = dependencies.syncBuilds ?? syncSiteBuilds;
  await sync(current.site.siteId, page.builds);
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "node_builds_list_read",
    targetType: "site_builds",
    result: "SUCCESS",
    metadata: {
      page: page.pagination.page,
      perPage: page.pagination.perPage,
      returned: page.builds.length,
      total: page.pagination.total,
      correlationId: page.correlationId,
    },
  });

  return {
    builds: page.builds,
    pagination: page.pagination,
  };
}

export async function getBuildLogsForSite(
  current: BuildAccessContext,
  input: { uuid: string; fromLine: number },
  dependencies: BuildServiceDependencies = {},
) {
  assertPermission(current.site, "node.build.logs");
  const audit = dependencies.audit ?? writeAuditEvent;
  const findBuild = dependencies.findBuild ?? findSiteBuild;
  let build = await findBuild(current.site.siteId, input.uuid);
  if (!build) {
    await writeAuditSafely(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_access_denied",
      targetType: "site_build",
      targetIdentifier: input.uuid,
      result: "DENIED",
      metadata: {
        capability: "node.build.logs",
        reason: "unbound_build",
      },
    });
    throw new AppError("NOT_FOUND", "Build not found.", 404);
  }

  const client = dependencies.client ?? createHostingerClient();
  if (isActiveBuild(build.state)) {
    try {
      const refreshed = await client.listNodeBuilds(
        current.site.hostingerUsername,
        current.site.primaryDomain,
        { page: 1, perPage: 100 },
      );
      const sync = dependencies.syncBuilds ?? syncSiteBuilds;
      await sync(current.site.siteId, refreshed.builds);
      build =
        refreshed.builds.find((candidate) => candidate.uuid === input.uuid) ??
        build;
    } catch (error) {
      await auditHostingerError(
        audit,
        current,
        "node_build_status_refresh",
        error,
        input.uuid,
      );
      throw error;
    }
  }

  try {
    const result = await client.getNodeBuildLogs(
      current.site.hostingerUsername,
      current.site.primaryDomain,
      input.uuid,
      input.fromLine,
    );
    const sanitized = sanitizeBuildLogs(result.logs);
    const nextFromLine = Math.max(input.fromLine, result.lines);
    await writeAuditSafely(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation:
        input.fromLine === 0
          ? "node_build_logs_opened"
          : "node_build_logs_read",
      targetType: "site_build",
      targetIdentifier: input.uuid,
      result: "SUCCESS",
      metadata: {
        fromLine: input.fromLine,
        nextFromLine,
        bytes: sanitized.bytes,
        truncated: sanitized.truncated,
        state: build.state,
        correlationId: result.correlationId,
      },
    });
    return {
      build: {
        uuid: build.uuid,
        state: build.state,
      },
      content: sanitized.content,
      fromLine: input.fromLine,
      nextFromLine,
      bytes: sanitized.bytes,
      truncated: sanitized.truncated,
      polling: isActiveBuild(build.state),
    };
  } catch (error) {
    await auditHostingerError(
      audit,
      current,
      "node_build_logs",
      error,
      input.uuid,
    );
    throw error;
  }
}

export async function syncSiteBuilds(
  siteId: string,
  builds: NodeBuildSummary[],
) {
  if (builds.length === 0) return;
  const now = new Date();
  let rows: { uuid: string }[];
  try {
    rows = await getDb()
      .insert(siteBuilds)
      .values(
        builds.map((build) => ({
          siteId,
          buildUuid: build.uuid,
          state: build.state,
          origin: build.origin ?? null,
          hostingerCreatedAt: build.createdAt
            ? new Date(build.createdAt)
            : null,
          hostingerUpdatedAt: build.updatedAt
            ? new Date(build.updatedAt)
            : null,
          lastVerifiedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: siteBuilds.buildUuid,
        set: {
          state: sql`excluded.state`,
          origin: sql`excluded.origin`,
          hostingerCreatedAt: sql`excluded.hostinger_created_at`,
          hostingerUpdatedAt: sql`excluded.hostinger_updated_at`,
          lastVerifiedAt: now,
          updatedAt: now,
        },
        setWhere: eq(siteBuilds.siteId, siteId),
      })
      .returning({ uuid: siteBuilds.buildUuid });
  } catch (error) {
    throw buildMigrationRequiredError(error) ?? error;
  }

  if (rows.length !== builds.length) {
    throw new AppError(
      "CONFLICT",
      "Build ownership could not be verified.",
      409,
    );
  }
}

export async function findSiteBuild(
  siteId: string,
  buildUuid: string,
): Promise<BoundSiteBuild | undefined> {
  const [build] = await getDb()
    .select({
      uuid: siteBuilds.buildUuid,
      state: siteBuilds.state,
      origin: siteBuilds.origin,
      createdAt: siteBuilds.hostingerCreatedAt,
      updatedAt: siteBuilds.hostingerUpdatedAt,
    })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.siteId, siteId),
        eq(siteBuilds.buildUuid, buildUuid),
      ),
    )
    .limit(1);
  return build
    ? {
        uuid: build.uuid,
        state: build.state,
        origin: build.origin ?? undefined,
        createdAt: build.createdAt?.toISOString(),
        updatedAt: build.updatedAt?.toISOString(),
      }
    : undefined;
}

export function isActiveBuild(state: NodeBuildState) {
  return state === "pending" || state === "running";
}

function assertPermission(
  site: SiteAccessRecord,
  capability: HostingerSiteCapability,
) {
  assertHostingerSiteAccess(site.membershipRole, capability);
}

async function auditHostingerError(
  audit: typeof writeAuditEvent,
  current: BuildAccessContext,
  operation: string,
  error: unknown,
  buildUuid?: string,
) {
  const rateLimited =
    error instanceof AppError && error.code === "RATE_LIMITED";
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: rateLimited
      ? "hostinger_rate_limited"
      : "hostinger_request_failed",
    targetType: buildUuid ? "site_build" : "site_builds",
    targetIdentifier: buildUuid,
    result: "FAILURE",
    metadata: {
      request: operation,
      errorCode:
        error instanceof AppError ? error.code : "INTERNAL_ERROR",
      status: error instanceof AppError ? error.status : 500,
      correlationId:
        error instanceof AppError ? error.correlationId : undefined,
    },
  });
}

async function writeAuditSafely(
  audit: typeof writeAuditEvent,
  event: Parameters<typeof writeAuditEvent>[0],
) {
  try {
    await audit(event);
  } catch {
    // A secondary audit persistence failure must not expose or replace a
    // controlled read result. No operational payload is logged here.
  }
}
