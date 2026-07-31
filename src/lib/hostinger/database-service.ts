import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteDatabases } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import { AppError } from "@/lib/errors";
import {
  createHostingerClient,
  type HostingerClient,
  type HostingerDatabasePage,
  type HostingerDatabaseSummary,
} from "./client";
import type {
  ChangeDatabasePasswordInput,
  CreateDatabaseInput,
  DeleteDatabaseInput,
  RemoteConnectionInput,
} from "./database-input";
import { databaseMigrationRequiredError } from "./database-schema-diagnostic";
import { normalizeDomain } from "./domain";
import {
  claimHostingerOperation,
  finishHostingerOperation,
  getHostingerOperationByIdempotency,
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

const MAX_DATABASE_SCAN_PAGES = 100;

export const DATABASE_CREATE_OPERATION = "database.create";
export const DATABASE_PASSWORD_OPERATION = "database.password.change";
export const DATABASE_REPAIR_OPERATION = "database.repair";
export const DATABASE_DELETE_OPERATION = "database.delete";
export const DATABASE_REMOTE_ADD_OPERATION =
  "database.remote_connection.add";
export const DATABASE_REMOTE_REMOVE_OPERATION =
  "database.remote_connection.remove";

export type DatabaseAccessContext = {
  user: { id: string };
  site: SiteAccessRecord;
};

export type SiteDatabaseRecord = {
  id: string;
  name: string;
  user: string;
  domain: string;
  diskUsageMb?: number;
  maxSizeMb?: number;
  createdAt?: string;
  updatedAt?: string;
  lastVerifiedAt: string;
};

export type DatabaseMutationOutcome = {
  accepted: true;
  referenceId: string;
  idempotencyStatus: "created" | "replayed";
  synchronized?: boolean;
  reconciled?: boolean;
};

type DatabaseClient = Pick<
  HostingerClient,
  | "listDatabases"
  | "createDatabase"
  | "changeDatabasePassword"
  | "deleteDatabase"
  | "repairDatabase"
  | "listDatabaseRemoteConnections"
  | "addDatabaseRemoteConnection"
  | "removeDatabaseRemoteConnection"
  | "getDatabasePhpMyAdminLink"
>;

type DatabaseServiceDependencies = {
  client?: DatabaseClient;
  syncDatabases?: typeof syncSiteDatabases;
  findDatabase?: typeof findSiteDatabase;
  deleteBinding?: typeof deleteSiteDatabaseBinding;
  claimOperation?: typeof claimHostingerOperation;
  finishOperation?: typeof finishHostingerOperation;
  findOperation?: typeof getHostingerOperationByIdempotency;
  audit?: typeof writeAuditEvent;
  createReferenceId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
};

export async function listDatabasesForSite(
  current: DatabaseAccessContext,
  pagination: { page: number; perPage: number },
  dependencies: DatabaseServiceDependencies = {},
) {
  assertHostingerSiteAccess(
    current.site.membershipRole,
    "database.list",
  );
  const client = dependencies.client ?? createHostingerClient();
  const audit = dependencies.audit ?? writeAuditEvent;
  let pages: HostingerDatabasePage[];
  try {
    pages = await listAllLiveDatabases(current, client);
  } catch (error) {
    await auditHostingerFailure(
      audit,
      current,
      "database_list",
      error,
    );
    throw error;
  }

  const { databases: live, discarded } =
    collectSanitizedDatabases(pages);
  const sync = dependencies.syncDatabases ?? syncSiteDatabases;
  const bindings = await sync(current.site.siteId, live);
  const bindingByName = new Map(
    bindings.map((binding) => [binding.name, binding]),
  );
  const safeTotal = live.length;
  const totalPages =
    safeTotal === 0 ? 0 : Math.ceil(safeTotal / pagination.perPage);
  const start = (pagination.page - 1) * pagination.perPage;
  const pageDatabases = live.slice(start, start + pagination.perPage);
  const databases = pageDatabases.map((database) => {
    const binding = bindingByName.get(database.name);
    if (!binding) {
      throw new AppError(
        "CONFLICT",
        "Database ownership could not be verified.",
        409,
      );
    }
    return binding;
  });

  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_database_list",
    targetType: "site_databases",
    result: "SUCCESS",
    metadata: {
      capability: "database.list",
      page: pagination.page,
      perPage: pagination.perPage,
      returned: databases.length,
      total: safeTotal,
      discardedInvalid: discarded.invalid,
      discardedMissingDomain: discarded.missingDomain,
      discardedOtherDomain: discarded.otherDomain,
    },
  });

  return {
    databases,
    pagination: {
      page: pagination.page,
      perPage: pagination.perPage,
      total: safeTotal,
      totalPages,
      hasPrevious: pagination.page > 1,
      hasNext: pagination.page < totalPages,
    },
    discarded,
    lastVerifiedAt:
      bindings.length > 0
        ? bindings
            .map((database) => database.lastVerifiedAt)
            .sort()
            .at(-1)
        : new Date().toISOString(),
  };
}

export async function getDatabaseOverviewForSite(
  current: DatabaseAccessContext,
  dependencies: DatabaseServiceDependencies = {},
) {
  assertHostingerSiteAccess(
    current.site.membershipRole,
    "database.list",
  );
  const client = dependencies.client ?? createHostingerClient();
  const audit = dependencies.audit ?? writeAuditEvent;
  let pages: HostingerDatabasePage[];
  try {
    pages = await listAllLiveDatabases(current, client);
  } catch (error) {
    await auditHostingerFailure(
      audit,
      current,
      "database_overview",
      error,
    );
    throw error;
  }
  const { databases: live, discarded } =
    collectSanitizedDatabases(pages);
  const sync = dependencies.syncDatabases ?? syncSiteDatabases;
  const bindings = await sync(current.site.siteId, live);
  const diskValues = live.map((item) => item.diskUsageMb);
  const maxValues = live.map((item) => item.maxSizeMb);
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_database_overview",
    targetType: "site_databases",
    result: "SUCCESS",
    metadata: {
      capability: "database.list",
      returned: live.length,
      discardedInvalid: discarded.invalid,
      discardedMissingDomain: discarded.missingDomain,
      discardedOtherDomain: discarded.otherDomain,
    },
  });
  return {
    count: live.length,
    diskUsageMb: diskValues.every(
      (value): value is number => value !== undefined,
    )
      ? diskValues.reduce((total, value) => total + value, 0)
      : undefined,
    maxSizeMb: maxValues.every(
      (value): value is number => value !== undefined,
    )
      ? maxValues.reduce((total, value) => total + value, 0)
      : undefined,
    lastVerifiedAt:
      bindings
        .map((binding) => binding.lastVerifiedAt)
        .sort()
        .at(-1) ?? new Date().toISOString(),
    discarded,
  };
}

export async function createDatabaseForSite(
  current: DatabaseAccessContext,
  input: CreateDatabaseInput,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
): Promise<DatabaseMutationOutcome> {
  assertHostingerSiteAccess(
    current.site.membershipRole,
    DATABASE_CREATE_OPERATION,
  );
  const name = prefixedIdentifier(
    current.site.hostingerUsername,
    input.nameSuffix,
  );
  const user = prefixedIdentifier(
    current.site.hostingerUsername,
    input.userSuffix,
  );
  const client = dependencies.client ?? createHostingerClient();

  let synchronized = false;
  const outcome = await performDurableMutation(
    current,
    {
      capability: DATABASE_CREATE_OPERATION,
      operationType: DATABASE_CREATE_OPERATION,
      idempotencyKey,
      resourceName: name,
      targetIdentifier: resourceHash(name),
      request: "database_create",
      mutate: async () => {
        const existing = await findLiveDatabaseByName(
          current,
          client,
          name,
        );
        if (existing) {
          await writeAuditSafely(
            dependencies.audit ?? writeAuditEvent,
            {
              actorUserId: current.user.id,
              siteId: current.site.siteId,
              operation: "hostinger_database_create_duplicate",
              targetType: "site_database",
              targetIdentifier: resourceHash(name),
              result: "DENIED",
              metadata: {
                capability: DATABASE_CREATE_OPERATION,
                reason: "database_exists",
              },
            },
          );
          throw new AppError(
            "CONFLICT",
            "A database with this suffix already exists.",
            409,
          );
        }
        return await client.createDatabase(
          current.site.hostingerUsername,
          {
            name,
            user,
            password: input.password,
            websiteDomain: current.site.primaryDomain,
          },
        );
      },
      afterAccepted: async () => {
        synchronized = await reconcileCreatedDatabase(
          current,
          client,
          name,
          user,
          dependencies,
        );
      },
    },
    dependencies,
  );
  return { ...outcome, synchronized };
}

export async function changeDatabasePasswordForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  input: ChangeDatabasePasswordInput,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  const capability = "database.password.change" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const binding = await requireBinding(
    current,
    databaseId,
    dependencies,
    capability,
  );
  const client = dependencies.client ?? createHostingerClient();
  return await performDurableMutation(
    current,
    {
      capability,
      operationType: DATABASE_PASSWORD_OPERATION,
      idempotencyKey,
      resourceName: binding.name,
      targetIdentifier: binding.id,
      request: "database_password_change",
      mutate: async () => {
        await verifyLiveBinding(current, binding, client, dependencies);
        return await client.changeDatabasePassword(
          current.site.hostingerUsername,
          binding.name,
          input.password,
        );
      },
    },
    dependencies,
  );
}

export async function repairDatabaseForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  const capability = "database.repair" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const binding = await requireBinding(
    current,
    databaseId,
    dependencies,
    capability,
  );
  const client = dependencies.client ?? createHostingerClient();
  const outcome = await performDurableMutation(
    current,
    {
      capability,
      operationType: DATABASE_REPAIR_OPERATION,
      idempotencyKey,
      resourceName: binding.name,
      targetIdentifier: binding.id,
      request: "database_repair",
      mutate: async () => {
        await verifyLiveBinding(current, binding, client, dependencies);
        return await client.repairDatabase(
          current.site.hostingerUsername,
          binding.name,
        );
      },
    },
    dependencies,
  );
  return { ...outcome, queued: true as const };
}

export async function deleteDatabaseForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  input: DeleteDatabaseInput,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  const capability = "database.delete" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const idempotencyKeyHash = createHash("sha256")
    .update(idempotencyKey.toLowerCase())
    .digest("hex");
  const previous = await (
    dependencies.findOperation ??
    getHostingerOperationByIdempotency
  )(
    current.site.siteId,
    DATABASE_DELETE_OPERATION,
    idempotencyKeyHash,
  );
  if (previous) {
    await writeAuditSafely(dependencies.audit ?? writeAuditEvent, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_database_operation_duplicate",
      targetType: "site_database",
      result:
        previous.status === "SUCCEEDED" ? "SUCCESS" : "DENIED",
      metadata: {
        capability,
        referenceId: previous.referenceId,
        idempotencyStatus: previous.status,
      },
    });
    reportHostingerOperationDiagnostic({
      referenceId: previous.referenceId,
      phase: "database_delete",
      upstreamStatus:
        previous.status === "SUCCEEDED" ? 200 : 409,
      operationType: DATABASE_DELETE_OPERATION,
      idempotencyStatus: "duplicate",
      result:
        previous.status === "SUCCEEDED" ? "success" : "denied",
    });
    if (previous.status === "SUCCEEDED") {
      return {
        accepted: true as const,
        referenceId: previous.referenceId,
        idempotencyStatus: "replayed" as const,
      };
    }
    throw new AppError(
      "CONFLICT",
      previous.status === "IN_PROGRESS"
        ? "This database deletion is already in progress."
        : "This database deletion already failed and will not be sent again.",
      409,
      undefined,
      previous.referenceId,
      previous.status === "IN_PROGRESS" ? 5 : undefined,
    );
  }
  const binding = await requireBinding(
    current,
    databaseId,
    dependencies,
    capability,
  );
  if (input.confirmation !== binding.name) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Type the exact database name to confirm deletion.",
      400,
    );
  }
  const client = dependencies.client ?? createHostingerClient();
  return await performDurableMutation(
    current,
    {
      capability,
      operationType: DATABASE_DELETE_OPERATION,
      idempotencyKey,
      resourceName: binding.name,
      targetIdentifier: binding.id,
      request: "database_delete",
      mutate: async () => {
        await verifyLiveBinding(current, binding, client, dependencies);
        try {
          return await client.deleteDatabase(
            current.site.hostingerUsername,
            binding.name,
          );
        } catch (error) {
          if (!isAmbiguousDeleteError(error)) throw error;
          try {
            const remaining = await findLiveDatabaseByName(
              current,
              client,
              binding.name,
            );
            if (!remaining) {
              return {
                accepted: true as const,
                correlationId:
                  error instanceof AppError
                    ? error.correlationId
                    : undefined,
              };
            }
          } catch {
            // Preserve the original ambiguous mutation error.
          }
          throw error;
        }
      },
      afterAccepted: async () => {
        const remove =
          dependencies.deleteBinding ?? deleteSiteDatabaseBinding;
        await remove(current.site.siteId, binding.id);
      },
    },
    dependencies,
  );
}

export async function getPhpMyAdminLinkForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  const capability = "database.phpmyadmin.link" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const binding = await requireBinding(
    current,
    databaseId,
    dependencies,
    capability,
  );
  const client = dependencies.client ?? createHostingerClient();
  const startedAt = Date.now();
  const referenceId =
    dependencies.createReferenceId?.() ??
    createDiagnosticReferenceId();
  try {
    await verifyLiveBinding(current, binding, client, dependencies);
    const result = await client.getDatabasePhpMyAdminLink(
      current.site.hostingerUsername,
      binding.name,
    );
    await writeAuditSafely(dependencies.audit ?? writeAuditEvent, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_phpmyadmin_link_requested",
      targetType: "site_database",
      targetIdentifier: binding.id,
      result: "SUCCESS",
      metadata: {
        capability,
        correlationId: safeCorrelationId(result.correlationId, current),
      },
    });
    reportHostingerOperationDiagnostic({
      referenceId,
      phase: "database_phpmyadmin",
      upstreamStatus: 200,
      correlationId: result.correlationId,
      operationType: "database.phpmyadmin.link",
      idempotencyStatus: "not_applicable",
      result: "success",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        binding.name,
        binding.user,
        result.link,
      ],
    });
    return { link: result.link, referenceId };
  } catch (error) {
    await auditHostingerFailure(
      dependencies.audit ?? writeAuditEvent,
      current,
      "database_phpmyadmin_link",
      error,
      binding.id,
    );
    const controlled =
      error instanceof AppError
        ? new AppError(
            error.code,
            error.message,
            error.status,
            safeCorrelationId(
              error.correlationId,
              current,
              binding.name,
            ),
            referenceId,
            error.retryAfterSeconds,
          )
        : new AppError(
            "HOSTINGER_ERROR",
            "The phpMyAdmin link could not be generated.",
            503,
            undefined,
            referenceId,
          );
    reportHostingerOperationDiagnostic({
      referenceId,
      phase: "database_phpmyadmin",
      upstreamStatus: controlled.status,
      correlationId: controlled.correlationId,
      operationType: "database.phpmyadmin.link",
      idempotencyStatus: "not_applicable",
      result: "failure",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        binding.name,
        binding.user,
      ],
    });
    throw controlled;
  }
}

export async function listRemoteConnectionsForSite(
  current: DatabaseAccessContext,
  dependencies: DatabaseServiceDependencies = {},
) {
  const capability = "database.remote.connections" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const client = dependencies.client ?? createHostingerClient();
  let pages: HostingerDatabasePage[];
  try {
    pages = await listAllLiveDatabases(current, client);
  } catch (error) {
    await auditHostingerFailure(
      dependencies.audit ?? writeAuditEvent,
      current,
      "database_remote_connection_preflight",
      error,
    );
    throw error;
  }
  const { databases: live } = collectSanitizedDatabases(pages);
  const sync = dependencies.syncDatabases ?? syncSiteDatabases;
  const bindings = await sync(current.site.siteId, live);
  const authorized = new Map(
    live.map((database) => [
      remoteIdentity(database.name, database.user),
      bindings.find((binding) => binding.name === database.name),
    ]),
  );

  let result: Awaited<
    ReturnType<DatabaseClient["listDatabaseRemoteConnections"]>
  >;
  try {
    result = await client.listDatabaseRemoteConnections(
      current.site.hostingerUsername,
      current.site.primaryDomain,
    );
  } catch (error) {
    await auditHostingerFailure(
      dependencies.audit ?? writeAuditEvent,
      current,
      "database_remote_connection_list",
      error,
    );
    throw error;
  }

  const connections: { databaseId: string; ip: string }[] = [];
  const seen = new Set<string>();
  let discardedOtherDatabase = 0;
  let discardedUnsupported = result.discardedInvalid;
  for (const connection of result.connections) {
    const binding = authorized.get(
      remoteIdentity(
        connection.databaseName,
        connection.databaseUser,
      ),
    );
    if (!binding) {
      discardedOtherDatabase += 1;
      continue;
    }
    if (isIP(connection.ip) === 0) {
      discardedUnsupported += 1;
      continue;
    }
    const identity = `${binding.id}:${connection.ip}`;
    if (seen.has(identity)) {
      discardedUnsupported += 1;
      continue;
    }
    seen.add(identity);
    connections.push({ databaseId: binding.id, ip: connection.ip });
  }

  await writeAuditSafely(dependencies.audit ?? writeAuditEvent, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_database_remote_connection_list",
    targetType: "site_databases",
    result: "SUCCESS",
    metadata: {
      capability,
      returned: connections.length,
      discardedOtherDatabase,
      discardedUnsupported,
      correlationId: safeCorrelationId(result.correlationId, current),
    },
  });
  return {
    connections,
    discarded: {
      otherDatabase: discardedOtherDatabase,
      unsupported: discardedUnsupported,
    },
  };
}

export async function addRemoteConnectionForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  input: RemoteConnectionInput,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  return await mutateRemoteConnection(
    current,
    databaseId,
    input,
    idempotencyKey,
    "add",
    dependencies,
  );
}

export async function removeRemoteConnectionForSite(
  current: DatabaseAccessContext,
  databaseId: string,
  input: RemoteConnectionInput,
  idempotencyKey: string,
  dependencies: DatabaseServiceDependencies = {},
) {
  return await mutateRemoteConnection(
    current,
    databaseId,
    input,
    idempotencyKey,
    "remove",
    dependencies,
  );
}

async function mutateRemoteConnection(
  current: DatabaseAccessContext,
  databaseId: string,
  input: RemoteConnectionInput,
  idempotencyKey: string,
  action: "add" | "remove",
  dependencies: DatabaseServiceDependencies,
) {
  const capability = "database.remote.connections" as const;
  assertHostingerSiteAccess(current.site.membershipRole, capability);
  const binding = await requireBinding(
    current,
    databaseId,
    dependencies,
    capability,
  );
  const client = dependencies.client ?? createHostingerClient();
  let reconciled = false;
  const outcome = await performDurableMutation(
    current,
    {
      capability,
      operationType:
        action === "add"
          ? DATABASE_REMOTE_ADD_OPERATION
          : DATABASE_REMOTE_REMOVE_OPERATION,
      idempotencyKey,
      resourceName: binding.name,
      targetIdentifier: binding.id,
      request:
        action === "add"
          ? "database_remote_connection_add"
          : "database_remote_connection_remove",
      mutate: async () => {
        await verifyLiveBinding(current, binding, client, dependencies);
        if (action === "remove") {
          await assertRemoteConnectionPresent(
            current,
            binding,
            input.ip,
            client,
          );
        }
        return action === "add"
          ? await client.addDatabaseRemoteConnection(
              current.site.hostingerUsername,
              binding.name,
              input.ip,
            )
          : await client.removeDatabaseRemoteConnection(
              current.site.hostingerUsername,
              binding.name,
              input.ip,
            );
      },
      afterAccepted: async () => {
        reconciled = await reconcileRemoteConnection(
          current,
          binding,
          input.ip,
          action,
          client,
        );
      },
    },
    dependencies,
  );
  return { ...outcome, reconciled };
}

type DurableMutation = {
  capability: HostingerSiteCapability;
  operationType: string;
  idempotencyKey: string;
  resourceName: string;
  targetIdentifier: string;
  request: string;
  mutate: () => Promise<{ accepted: true; correlationId?: string }>;
  afterAccepted?: () => Promise<void>;
};

async function performDurableMutation(
  current: DatabaseAccessContext,
  mutation: DurableMutation,
  dependencies: DatabaseServiceDependencies,
): Promise<DatabaseMutationOutcome> {
  const idempotencyKeyHash = createHash("sha256")
    .update(mutation.idempotencyKey.toLowerCase())
    .digest("hex");
  const referenceId =
    dependencies.createReferenceId?.() ??
    randomBytes(6).toString("hex");
  const resourceKeyHash = resourceHash(mutation.resourceName);
  const claimOperation =
    dependencies.claimOperation ?? claimHostingerOperation;
  const finishOperation =
    dependencies.finishOperation ?? finishHostingerOperation;
  const audit = dependencies.audit ?? writeAuditEvent;
  const startedAt = Date.now();

  const claim = await claimOperation({
    siteId: current.site.siteId,
    actorUserId: current.user.id,
    operationType: mutation.operationType,
    resourceKeyHash,
    idempotencyKeyHash,
    referenceId,
    cooldownSeconds: 0,
  });
  if (claim.kind !== "claimed") {
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: diagnosticPhase(mutation.request),
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
    return await handleUnclaimedDatabaseMutation(
      current,
      mutation,
      claim,
      audit,
    );
  }

  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${mutation.request}_requested`,
    targetType: "site_database",
    targetIdentifier: mutation.targetIdentifier,
    result: "SUCCESS",
    metadata: {
      capability: mutation.capability,
      referenceId: claim.operation.referenceId,
      idempotencyStatus: "claimed",
    },
  });

  let result: Awaited<ReturnType<DurableMutation["mutate"]>>;
  try {
    result = await mutation.mutate();
  } catch (error) {
    const controlled = controlledMutationError(
      error,
      claim.operation.referenceId,
      current,
      mutation.resourceName,
    );
    await finishOperationSafely(finishOperation, {
      siteId: current.site.siteId,
      operationType: mutation.operationType,
      idempotencyKeyHash,
      status: "FAILED",
      correlationId: controlled.correlationId,
    });
    await auditMutationFailure(
      audit,
      current,
      mutation,
      controlled,
      claim.operation.referenceId,
    );
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: diagnosticPhase(mutation.request),
      upstreamStatus: controlled.status,
      correlationId: controlled.correlationId,
      operationType: mutation.operationType,
      idempotencyStatus: "failed",
      result: "failure",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        mutation.resourceName,
      ],
    });
    throw controlled;
  }

  let postAcceptedError = false;
  if (mutation.afterAccepted) {
    try {
      await mutation.afterAccepted();
    } catch {
      postAcceptedError = true;
    }
  }
  const correlationId = safeCorrelationId(
    result.correlationId,
    current,
    mutation.resourceName,
  );
  const completed = await finishOperationSafely(finishOperation, {
    siteId: current.site.siteId,
    operationType: mutation.operationType,
    idempotencyKeyHash,
    status: "SUCCEEDED",
    correlationId,
  });
  if (!completed || postAcceptedError) {
    const error = new AppError(
      "INTERNAL_ERROR",
      "Hostinger accepted the request, but its local result could not be recorded. Do not retry this request.",
      503,
      correlationId,
      claim.operation.referenceId,
    );
    await auditMutationFailure(
      audit,
      current,
      mutation,
      error,
      claim.operation.referenceId,
      "success_persistence",
    );
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: diagnosticPhase(mutation.request),
      upstreamStatus: 503,
      correlationId,
      operationType: mutation.operationType,
      idempotencyStatus: "failed",
      result: "failure",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        mutation.resourceName,
      ],
    });
    throw error;
  }

  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${mutation.request}_completed`,
    targetType: "site_database",
    targetIdentifier: mutation.targetIdentifier,
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
    phase: diagnosticPhase(mutation.request),
    upstreamStatus: 200,
    correlationId,
    operationType: mutation.operationType,
    idempotencyStatus: "completed",
    result: "accepted",
    startedAt,
    forbiddenValues: [
      current.site.hostingerUsername,
      current.site.primaryDomain,
      mutation.resourceName,
    ],
  });
  return operationOutcome(claim, "created");
}

async function handleUnclaimedDatabaseMutation(
  current: DatabaseAccessContext,
  mutation: DurableMutation,
  claim: Exclude<HostingerOperationClaim, { kind: "claimed" }>,
  audit: typeof writeAuditEvent,
): Promise<DatabaseMutationOutcome> {
  const duplicate = claim.kind === "duplicate";
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: duplicate
      ? "hostinger_database_operation_duplicate"
      : "hostinger_database_operation_conflict",
    targetType: "site_database",
    targetIdentifier: mutation.targetIdentifier,
    result:
      duplicate && claim.operation.status === "SUCCEEDED"
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
  if (duplicate && claim.operation.status === "SUCCEEDED") {
    return operationOutcome(claim, "replayed");
  }
  throw new AppError(
    "CONFLICT",
    duplicate
      ? claim.operation.status === "IN_PROGRESS"
        ? "This database request is already in progress."
        : "This database request already failed and will not be sent again."
      : "Another operation is already in progress for this database.",
    409,
    undefined,
    claim.operation.referenceId,
    claim.operation.status === "IN_PROGRESS" ? 5 : undefined,
  );
}

function operationOutcome(
  claim: HostingerOperationClaim,
  idempotencyStatus: DatabaseMutationOutcome["idempotencyStatus"],
): DatabaseMutationOutcome {
  return {
    accepted: true,
    referenceId: claim.operation.referenceId,
    idempotencyStatus,
  };
}

async function requireBinding(
  current: DatabaseAccessContext,
  databaseId: string,
  dependencies: DatabaseServiceDependencies,
  capability: HostingerSiteCapability,
) {
  const find = dependencies.findDatabase ?? findSiteDatabase;
  const binding = await find(current.site.siteId, databaseId);
  if (binding) return binding;
  await writeAuditSafely(dependencies.audit ?? writeAuditEvent, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: "hostinger_database_access_denied",
    targetType: "site_database",
    targetIdentifier: databaseId,
    result: "DENIED",
    metadata: { capability, reason: "unbound_database" },
  });
  throw new AppError("NOT_FOUND", "Database not found.", 404);
}

async function verifyLiveBinding(
  current: DatabaseAccessContext,
  binding: SiteDatabaseRecord,
  client: DatabaseClient,
  dependencies: DatabaseServiceDependencies,
) {
  const startedAt = Date.now();
  const referenceId = createDiagnosticReferenceId();
  let live: HostingerDatabaseSummary | undefined;
  try {
    live = await findLiveDatabaseByName(current, client, binding.name);
  } catch (error) {
    reportHostingerOperationDiagnostic({
      referenceId,
      phase: "database_live_verification",
      upstreamStatus:
        error instanceof AppError ? error.status : 502,
      correlationId:
        error instanceof AppError ? error.correlationId : undefined,
      operationType: "database.live.verify",
      idempotencyStatus: "not_applicable",
      result: "failure",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        binding.name,
        binding.user,
      ],
    });
    throw error;
  }
  if (
    !live ||
    live.name !== binding.name ||
    live.user !== binding.user ||
    live.domain !== normalizeDomain(binding.domain) ||
    live.domain !== normalizeDomain(current.site.primaryDomain)
  ) {
    await writeAuditSafely(dependencies.audit ?? writeAuditEvent, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_database_access_denied",
      targetType: "site_database",
      targetIdentifier: binding.id,
      result: "DENIED",
      metadata: {
        reason: "live_domain_ownership_not_confirmed",
      },
    });
    reportHostingerOperationDiagnostic({
      referenceId,
      phase: "database_live_verification",
      upstreamStatus: 404,
      operationType: "database.live.verify",
      idempotencyStatus: "not_applicable",
      result: "denied",
      startedAt,
      forbiddenValues: [
        current.site.hostingerUsername,
        current.site.primaryDomain,
        binding.name,
        binding.user,
      ],
    });
    throw new AppError("NOT_FOUND", "Database not found.", 404);
  }
  const sync = dependencies.syncDatabases ?? syncSiteDatabases;
  await sync(current.site.siteId, [live]);
  reportHostingerOperationDiagnostic({
    referenceId,
    phase: "database_live_verification",
    upstreamStatus: 200,
    operationType: "database.live.verify",
    idempotencyStatus: "not_applicable",
    result: "success",
    startedAt,
    forbiddenValues: [
      current.site.hostingerUsername,
      current.site.primaryDomain,
      binding.name,
      binding.user,
    ],
  });
  return live;
}

async function findLiveDatabaseByName(
  current: DatabaseAccessContext,
  client: Pick<DatabaseClient, "listDatabases">,
  name: string,
) {
  const result = await client.listDatabases(
    current.site.hostingerUsername,
    current.site.primaryDomain,
    { page: 1, perPage: 100, search: name },
    { allowUnfilteredFallback: true },
  );
  return result.databases.find(
    (database) => database.name === name,
  );
}

async function reconcileCreatedDatabase(
  current: DatabaseAccessContext,
  client: Pick<DatabaseClient, "listDatabases">,
  name: string,
  user: string,
  dependencies: DatabaseServiceDependencies,
) {
  const sleep =
    dependencies.sleep ??
    (async (milliseconds: number) =>
      await new Promise<void>((resolve) =>
        setTimeout(resolve, milliseconds),
      ));
  for (const delay of [0, 250, 750]) {
    if (delay > 0) await sleep(delay);
    try {
      const live = await findLiveDatabaseByName(current, client, name);
      if (
        live &&
        live.name === name &&
        live.user === user &&
        live.domain === normalizeDomain(current.site.primaryDomain)
      ) {
        const sync = dependencies.syncDatabases ?? syncSiteDatabases;
        await sync(current.site.siteId, [live]);
        return true;
      }
    } catch {
      // Creation is already accepted; reconciliation remains best-effort.
    }
  }
  return false;
}

async function assertRemoteConnectionPresent(
  current: DatabaseAccessContext,
  binding: SiteDatabaseRecord,
  ip: string,
  client: Pick<DatabaseClient, "listDatabaseRemoteConnections">,
) {
  const result = await client.listDatabaseRemoteConnections(
    current.site.hostingerUsername,
    current.site.primaryDomain,
  );
  if (
    !result.connections.some(
      (connection) =>
        connection.databaseName === binding.name &&
        connection.databaseUser === binding.user &&
        connection.ip === ip,
    )
  ) {
    throw new AppError(
      "NOT_FOUND",
      "The remote connection is no longer authorized.",
      404,
    );
  }
}

async function reconcileRemoteConnection(
  current: DatabaseAccessContext,
  binding: SiteDatabaseRecord,
  ip: string,
  action: "add" | "remove",
  client: Pick<DatabaseClient, "listDatabaseRemoteConnections">,
) {
  try {
    const result = await client.listDatabaseRemoteConnections(
      current.site.hostingerUsername,
      current.site.primaryDomain,
    );
    const exists = result.connections.some(
      (connection) =>
        connection.databaseName === binding.name &&
        connection.databaseUser === binding.user &&
        connection.ip === ip,
    );
    return action === "add" ? exists : !exists;
  } catch {
    return false;
  }
}

async function listAllLiveDatabases(
  current: DatabaseAccessContext,
  client: Pick<DatabaseClient, "listDatabases">,
) {
  const pages: HostingerDatabasePage[] = [];
  let page = 1;
  do {
    const result = await client.listDatabases(
      current.site.hostingerUsername,
      current.site.primaryDomain,
      { page, perPage: 100 },
      { allowUnfilteredFallback: true },
    );
    pages.push(result);
    if (!result.pagination.hasNext) return pages;
    page += 1;
  } while (page <= MAX_DATABASE_SCAN_PAGES);
  throw new AppError(
    "HOSTINGER_ERROR",
    "Hostinger returned an unsupported database result size.",
    502,
  );
}

function collectSanitizedDatabases(pages: HostingerDatabasePage[]) {
  const databases: HostingerDatabaseSummary[] = [];
  const seen = new Set<string>();
  const discarded = {
    invalid: 0,
    missingDomain: 0,
    otherDomain: 0,
  };
  for (const page of pages) {
    discarded.invalid += page.discarded.invalid;
    discarded.missingDomain += page.discarded.missingDomain;
    discarded.otherDomain += page.discarded.otherDomain;
    for (const database of page.databases) {
      if (seen.has(database.name)) {
        discarded.invalid += 1;
        continue;
      }
      seen.add(database.name);
      databases.push(database);
    }
  }
  return { databases, discarded };
}

export async function syncSiteDatabases(
  siteId: string,
  databases: HostingerDatabaseSummary[],
): Promise<SiteDatabaseRecord[]> {
  if (databases.length === 0) return [];
  const now = new Date();
  try {
    const rows = await getDb()
      .insert(siteDatabases)
      .values(
        databases.map((database) => ({
          siteId,
          name: database.name,
          nameKeyHash: resourceHash(database.name),
          databaseUser: database.user,
          verifiedDomain: database.domain,
          diskUsageMb: database.diskUsageMb ?? null,
          maxSizeMb: database.maxSizeMb ?? null,
          hostingerCreatedAt: database.createdAt
            ? new Date(database.createdAt)
            : null,
          hostingerUpdatedAt: database.updatedAt
            ? new Date(database.updatedAt)
            : null,
          lastVerifiedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: siteDatabases.nameKeyHash,
        set: {
          name: sql`excluded.name`,
          databaseUser: sql`excluded.database_user`,
          verifiedDomain: sql`excluded.verified_domain`,
          diskUsageMb: sql`excluded.disk_usage_mb`,
          maxSizeMb: sql`excluded.max_size_mb`,
          hostingerCreatedAt: sql`excluded.hostinger_created_at`,
          hostingerUpdatedAt: sql`excluded.hostinger_updated_at`,
          lastVerifiedAt: now,
          updatedAt: now,
        },
        setWhere: eq(siteDatabases.siteId, siteId),
      })
      .returning(databaseSelection());
    if (rows.length !== databases.length) {
      throw new AppError(
        "CONFLICT",
        "Database ownership could not be verified.",
        409,
      );
    }
    return rows.map(normalizeDatabaseRow);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw databaseMigrationRequiredError(error) ?? error;
  }
}

export async function findSiteDatabase(
  siteId: string,
  databaseId: string,
): Promise<SiteDatabaseRecord | undefined> {
  try {
    const [row] = await getDb()
      .select(databaseSelection())
      .from(siteDatabases)
      .where(
        and(
          eq(siteDatabases.siteId, siteId),
          eq(siteDatabases.id, databaseId),
        ),
      )
      .limit(1);
    return row ? normalizeDatabaseRow(row) : undefined;
  } catch (error) {
    throw databaseMigrationRequiredError(error) ?? error;
  }
}

export async function deleteSiteDatabaseBinding(
  siteId: string,
  databaseId: string,
) {
  try {
    const rows = await getDb()
      .delete(siteDatabases)
      .where(
        and(
          eq(siteDatabases.siteId, siteId),
          eq(siteDatabases.id, databaseId),
        ),
      )
      .returning({ id: siteDatabases.id });
    if (rows.length !== 1) {
      throw new AppError("NOT_FOUND", "Database not found.", 404);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw databaseMigrationRequiredError(error) ?? error;
  }
}

export async function listVerifiedDatabaseBindings(siteId: string) {
  try {
    const rows = await getDb()
      .select(databaseSelection())
      .from(siteDatabases)
      .where(eq(siteDatabases.siteId, siteId));
    return rows.map(normalizeDatabaseRow);
  } catch (error) {
    throw databaseMigrationRequiredError(error) ?? error;
  }
}

function databaseSelection() {
  return {
    id: siteDatabases.id,
    name: siteDatabases.name,
    user: siteDatabases.databaseUser,
    domain: siteDatabases.verifiedDomain,
    diskUsageMb: siteDatabases.diskUsageMb,
    maxSizeMb: siteDatabases.maxSizeMb,
    createdAt: siteDatabases.hostingerCreatedAt,
    updatedAt: siteDatabases.hostingerUpdatedAt,
    lastVerifiedAt: siteDatabases.lastVerifiedAt,
  };
}

function normalizeDatabaseRow(row: {
  id: string;
  name: string;
  user: string;
  domain: string;
  diskUsageMb: number | null;
  maxSizeMb: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastVerifiedAt: Date;
}): SiteDatabaseRecord {
  return {
    id: row.id,
    name: row.name,
    user: row.user,
    domain: row.domain,
    diskUsageMb: row.diskUsageMb ?? undefined,
    maxSizeMb: row.maxSizeMb ?? undefined,
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
  };
}

function prefixedIdentifier(username: string, suffix: string) {
  const value = `${username}_${suffix}`;
  if (
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The database suffix is too long for this account.",
      400,
    );
  }
  return value;
}

function resourceHash(name: string) {
  return createHash("sha256")
    .update(name.trim().toLowerCase())
    .digest("hex");
}

function remoteIdentity(name: string, user: string) {
  return `${name}\u0000${user}`;
}

function isAmbiguousDeleteError(error: unknown) {
  return (
    error instanceof AppError &&
    (error.status === 404 ||
      error.status === 503 ||
      error.status === 504)
  );
}

function diagnosticPhase(request: string): HostingerDiagnosticPhase {
  if (request === "database_create") return "database_create";
  if (request === "database_password_change") {
    return "database_change_password";
  }
  if (request === "database_repair") return "database_repair";
  if (request === "database_delete") return "database_delete";
  if (request === "database_remote_connection_add") {
    return "database_remote_add";
  }
  return "database_remote_remove";
}

function safeCorrelationId(
  value: unknown,
  current: DatabaseAccessContext,
  databaseName?: string,
) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    value.includes("://")
  ) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const forbidden = [
    current.site.hostingerUsername,
    current.site.primaryDomain,
    databaseName,
  ].filter((item): item is string => Boolean(item));
  return forbidden.some((item) =>
    normalized.includes(item.toLowerCase()),
  )
    ? undefined
    : value;
}

function controlledMutationError(
  error: unknown,
  referenceId: string,
  current: DatabaseAccessContext,
  databaseName: string,
) {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.status === 504
        ? "The Hostinger result is ambiguous. Do not retry with a new idempotency key."
        : error.message,
      error.status,
      safeCorrelationId(error.correlationId, current, databaseName),
      referenceId,
      error.retryAfterSeconds,
    );
  }
  return new AppError(
    "HOSTINGER_ERROR",
    "The Hostinger database request could not be completed.",
    503,
    undefined,
    referenceId,
  );
}

async function finishOperationSafely(
  finish: typeof finishHostingerOperation,
  input: Parameters<typeof finishHostingerOperation>[0],
) {
  try {
    return await finish(input);
  } catch {
    return false;
  }
}

async function auditMutationFailure(
  audit: typeof writeAuditEvent,
  current: DatabaseAccessContext,
  mutation: DurableMutation,
  error: AppError,
  referenceId: string,
  phase = "hostinger_request",
) {
  const metadata = {
    capability: mutation.capability,
    referenceId,
    correlationId: error.correlationId,
    errorCode: error.code,
    status: error.status,
    phase,
  };
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${mutation.request}_failed`,
    targetType: "site_database",
    targetIdentifier: mutation.targetIdentifier,
    result: "FAILURE",
    metadata,
  });
  if (error.code === "RATE_LIMITED") {
    await writeAuditSafely(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: "hostinger_rate_limited",
      targetType: "site_database",
      targetIdentifier: mutation.targetIdentifier,
      result: "FAILURE",
      metadata,
    });
  }
}

async function auditHostingerFailure(
  audit: typeof writeAuditEvent,
  current: DatabaseAccessContext,
  request: string,
  error: unknown,
  targetIdentifier?: string,
) {
  const controlled =
    error instanceof AppError
      ? error
      : new AppError("HOSTINGER_ERROR", "Hostinger request failed.", 503);
  const metadata = {
    request,
    errorCode: controlled.code,
    status: controlled.status,
    correlationId: safeCorrelationId(
      controlled.correlationId,
      current,
    ),
  };
  await writeAuditSafely(audit, {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation:
      controlled.code === "RATE_LIMITED"
        ? "hostinger_rate_limited"
        : "hostinger_database_request_failed",
    targetType: targetIdentifier
      ? "site_database"
      : "site_databases",
    targetIdentifier,
    result: "FAILURE",
    metadata,
  });
}

async function writeAuditSafely(
  audit: typeof writeAuditEvent,
  event: Parameters<typeof writeAuditEvent>[0],
) {
  try {
    await audit(event);
  } catch {
    // Audit persistence must not expose data or repeat an external mutation.
  }
}
