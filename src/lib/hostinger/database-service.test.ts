import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRemoteConnectionForSite,
  changeDatabasePasswordForSite,
  createDatabaseForSite,
  deleteDatabaseForSite,
  listDatabasesForSite,
  listRemoteConnectionsForSite,
  repairDatabaseForSite,
  type DatabaseAccessContext,
  type SiteDatabaseRecord,
} from "./database-service";

const siteId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const databaseId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const password = "Strong-password-123!";
const now = new Date("2026-07-29T10:00:00.000Z");

const liveDatabase = {
  name: "u123_shop",
  user: "u123_app",
  domain: "example.com",
  diskUsageMb: 25,
  maxSizeMb: 1024,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
};

const binding: SiteDatabaseRecord = {
  id: databaseId,
  ...liveDatabase,
  lastVerifiedAt: now.toISOString(),
};

const audit = vi.fn(async (event: unknown) => {
  void event;
});

beforeEach(() => {
  audit.mockClear();
});

describe("site-confined database service", () => {
  it.each(["ADMIN", "MEMBER"] as const)(
    "gives %s the same database list and operations",
    async (membershipRole) => {
      const client = {
        listDatabases: vi.fn(async () => page([liveDatabase])),
      };
      const syncDatabases = vi.fn(async () => [binding]);
      await expect(
        listDatabasesForSite(
          context(membershipRole),
          { page: 1, perPage: 25 },
          { client: client as never, syncDatabases, audit },
        ),
      ).resolves.toMatchObject({
        databases: [binding],
        pagination: { total: 1 },
      });
      expect(client.listDatabases).toHaveBeenCalledWith(
        "u123",
        "example.com",
        { page: 1, perPage: 100 },
        { allowUnfilteredFallback: true },
      );
    },
  );

  it("never forwards Hostinger account-level totals after server filtering", async () => {
    const unsafePage = page([liveDatabase]);
    unsafePage.pagination.total = 99;
    unsafePage.discarded.otherDomain = 2;
    const result = await listDatabasesForSite(
      context("ADMIN"),
      { page: 1, perPage: 25 },
      {
        client: {
          listDatabases: vi.fn(async () => unsafePage),
        } as never,
        syncDatabases: vi.fn(async () => [binding]),
        audit,
      },
    );
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.totalPages).toBe(1);
    expect(result.discarded.otherDomain).toBe(2);
  });

  it("collects every authorized page and recalculates dashboard pagination", async () => {
    const liveDatabases = [
      liveDatabase,
      {
        ...liveDatabase,
        name: "u123_reports",
        user: "u123_reports_user",
      },
      {
        ...liveDatabase,
        name: "u123_archive",
        user: "u123_archive_user",
      },
    ];
    const bindings = liveDatabases.map((database, index) => ({
      id: `44444444-4444-4444-8444-44444444444${index}`,
      ...database,
      lastVerifiedAt: now.toISOString(),
    }));
    const listDatabases = vi.fn(
      async (
        _username: string,
        _domain: string,
        pagination: { page: number },
      ) => ({
        ...page([liveDatabases[pagination.page - 1]]),
        pagination: {
          page: pagination.page,
          perPage: 100,
          total: 300,
          totalPages: 3,
          hasPrevious: pagination.page > 1,
          hasNext: pagination.page < 3,
        },
      }),
    );
    const syncDatabases = vi.fn(async () => bindings);

    const result = await listDatabasesForSite(
      context("ADMIN"),
      { page: 2, perPage: 2 },
      {
        client: { listDatabases } as never,
        syncDatabases,
        audit,
      },
    );

    expect(listDatabases).toHaveBeenCalledTimes(3);
    expect(listDatabases.mock.calls.map((call) => call[2].page)).toEqual([
      1, 2, 3,
    ]);
    expect(syncDatabases).toHaveBeenCalledWith(siteId, liveDatabases);
    expect(result.databases).toEqual([bindings[2]]);
    expect(result.pagination).toEqual({
      page: 2,
      perPage: 2,
      total: 3,
      totalPages: 2,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("fails closed instead of returning a partial result beyond the safe page limit", async () => {
    const listDatabases = vi.fn(async () => ({
      ...page([]),
      pagination: {
        page: 1,
        perPage: 100,
        total: 10_001,
        totalPages: 101,
        hasPrevious: false,
        hasNext: true,
      },
    }));

    await expect(
      listDatabasesForSite(
        context("ADMIN"),
        { page: 1, perPage: 25 },
        {
          client: { listDatabases } as never,
          syncDatabases: vi.fn(),
          audit,
        },
      ),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 502,
    });
    expect(listDatabases).toHaveBeenCalledTimes(100);
  });

  it("sets account username, full names and website domain only on the server", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([])),
      createDatabase: vi.fn(async () => ({
        accepted: true as const,
        correlationId: "corr-safe",
      })),
    };
    const dependencies = successfulMutationDependencies(client);

    await createDatabaseForSite(
      context("MEMBER"),
      {
        nameSuffix: "shop",
        userSuffix: "app",
        password,
        passwordConfirmation: password,
      },
      idempotencyKey,
      dependencies,
    );

    expect(client.createDatabase).toHaveBeenCalledWith("u123", {
      name: "u123_shop",
      user: "u123_app",
      password,
      websiteDomain: "example.com",
    });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /Strong-password-123|example\.com|u123_shop|u123_app/i,
    );
  });

  it("blocks a duplicate database before a create mutation", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      createDatabase: vi.fn(),
    };
    await expect(
      createDatabaseForSite(
        context("ADMIN"),
        {
          nameSuffix: "shop",
          userSuffix: "app",
          password,
          passwordConfirmation: password,
        },
        idempotencyKey,
        { client: client as never, audit },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(client.createDatabase).not.toHaveBeenCalled();
  });

  it("live-verifies the opaque binding before changing a password and never audits it", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      changeDatabasePassword: vi.fn(async () => ({
        accepted: true as const,
        correlationId: "corr-safe",
      })),
    };
    const dependencies = successfulMutationDependencies(client);

    await changeDatabasePasswordForSite(
      context("MEMBER"),
      databaseId,
      {
        password,
        passwordConfirmation: password,
        confirmed: true,
      },
      idempotencyKey,
      dependencies,
    );

    expect(dependencies.findDatabase).toHaveBeenCalledWith(
      siteId,
      databaseId,
    );
    expect(client.listDatabases).toHaveBeenCalledWith(
      "u123",
      "example.com",
      { page: 1, perPage: 100, search: "u123_shop" },
    );
    expect(client.changeDatabasePassword).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls)).not.toContain(password);
  });

  it("replays one repair idempotently and sends only one Hostinger call", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      repairDatabase: vi.fn(async () => ({
        accepted: true as const,
        correlationId: "corr-safe",
      })),
    };
    let completed = false;
    const claimOperation = vi.fn(async () =>
      completed
        ? {
            kind: "duplicate" as const,
            operation: {
              status: "SUCCEEDED" as const,
              referenceId: "abcdef123456",
              createdAt: now,
            },
          }
        : {
            kind: "claimed" as const,
            operation: {
              status: "IN_PROGRESS" as const,
              referenceId: "abcdef123456",
              createdAt: now,
            },
          },
    );
    const dependencies = successfulMutationDependencies(client, {
      claimOperation,
      finishOperation: vi.fn(async () => {
        completed = true;
        return true;
      }),
    });

    await expect(
      repairDatabaseForSite(
        context("ADMIN"),
        databaseId,
        idempotencyKey,
        dependencies,
      ),
    ).resolves.toMatchObject({ queued: true, idempotencyStatus: "created" });
    await expect(
      repairDatabaseForSite(
        context("MEMBER"),
        databaseId,
        idempotencyKey,
        dependencies,
      ),
    ).resolves.toMatchObject({ queued: true, idempotencyStatus: "replayed" });
    expect(client.repairDatabase).toHaveBeenCalledOnce();
  });

  it("requires the exact database name before live-verified deletion", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      deleteDatabase: vi.fn(async () => ({
        accepted: true as const,
      })),
    };
    const dependencies = successfulMutationDependencies(client);

    await expect(
      deleteDatabaseForSite(
        context("MEMBER"),
        databaseId,
        { confirmation: "shop", confirmed: true },
        idempotencyKey,
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
    expect(client.deleteDatabase).not.toHaveBeenCalled();

    await expect(
      deleteDatabaseForSite(
        context("MEMBER"),
        databaseId,
        { confirmation: "u123_shop", confirmed: true },
        idempotencyKey,
        dependencies,
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(client.deleteDatabase).toHaveBeenCalledOnce();
    expect(dependencies.deleteBinding).toHaveBeenCalledWith(
      siteId,
      databaseId,
    );
  });

  it("discards foreign databases and unsupported wildcard remote rules", async () => {
    const client = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      listDatabaseRemoteConnections: vi.fn(async () => ({
        connections: [
          {
            databaseName: "u123_shop",
            databaseUser: "u123_app",
            ip: "192.0.2.10",
          },
          {
            databaseName: "u123_shop",
            databaseUser: "u123_app",
            ip: "2001:db8::1",
          },
          {
            databaseName: "u123_shop",
            databaseUser: "u123_app",
            ip: "%",
          },
          {
            databaseName: "u123_foreign",
            databaseUser: "u123_foreign",
            ip: "192.0.2.20",
          },
        ],
        discardedInvalid: 0,
      })),
    };
    const result = await listRemoteConnectionsForSite(context("ADMIN"), {
      client: client as never,
      syncDatabases: vi.fn(async () => [binding]),
      audit,
    });

    expect(result).toEqual({
      connections: [
        { databaseId, ip: "192.0.2.10" },
        { databaseId, ip: "2001:db8::1" },
      ],
      discarded: { otherDatabase: 1, unsupported: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/u123_foreign|%/);
  });

  it("distinguishes a database preflight failure from a remote endpoint failure", async () => {
    const preflightClient = {
      listDatabases: vi.fn(async () => {
        throw new Error("preflight failed");
      }),
      listDatabaseRemoteConnections: vi.fn(),
    };
    await expect(
      listRemoteConnectionsForSite(context("ADMIN"), {
        client: preflightClient as never,
        audit,
      }),
    ).rejects.toThrow("preflight failed");
    expect(
      preflightClient.listDatabaseRemoteConnections,
    ).not.toHaveBeenCalled();
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: "hostinger_database_request_failed",
      metadata: {
        request: "database_remote_connection_preflight",
      },
    });

    audit.mockClear();
    const remoteClient = {
      listDatabases: vi.fn(async () => page([liveDatabase])),
      listDatabaseRemoteConnections: vi.fn(async () => {
        throw new Error("remote endpoint failed");
      }),
    };
    await expect(
      listRemoteConnectionsForSite(context("ADMIN"), {
        client: remoteClient as never,
        syncDatabases: vi.fn(async () => [binding]),
        audit,
      }),
    ).rejects.toThrow("remote endpoint failed");
    expect(remoteClient.listDatabaseRemoteConnections).toHaveBeenCalledOnce();
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: "hostinger_database_request_failed",
      metadata: {
        request: "database_remote_connection_list",
      },
    });
  });

  it("blocks an incompatible concurrent mutation before live verification", async () => {
    const client = {
      listDatabases: vi.fn(),
      addDatabaseRemoteConnection: vi.fn(),
    };
    const dependencies = successfulMutationDependencies(client, {
      claimOperation: vi.fn(async () => ({
        kind: "blocked" as const,
        reason: "in_progress" as const,
        operation: {
          status: "IN_PROGRESS" as const,
          referenceId: "abcdef123456",
          createdAt: now,
        },
      })),
    });

    await expect(
      addRemoteConnectionForSite(
        context("MEMBER"),
        databaseId,
        { ip: "192.0.2.10", confirmed: true },
        idempotencyKey,
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      referenceId: "abcdef123456",
    });
    expect(client.listDatabases).not.toHaveBeenCalled();
    expect(client.addDatabaseRemoteConnection).not.toHaveBeenCalled();
  });
});

function context(
  membershipRole: "ADMIN" | "MEMBER",
): DatabaseAccessContext {
  return {
    user: { id: actorId },
    site: {
      siteId,
      name: "Site",
      primaryDomain: "example.com",
      hostingerUsername: "u123",
      membershipRole,
    },
  };
}

function page(
  databases: typeof liveDatabase[],
) {
  return {
    databases,
    pagination: {
      page: 1,
      perPage: databases.length === 0 ? 100 : 25,
      total: databases.length,
      totalPages: databases.length === 0 ? 0 : 1,
      hasPrevious: false,
      hasNext: false,
    },
    discarded: { invalid: 0, missingDomain: 0, otherDomain: 0 },
  };
}

function successfulMutationDependencies(
  client: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    client: client as never,
    syncDatabases: vi.fn(async () => [binding]),
    findDatabase: vi.fn(async () => binding),
    deleteBinding: vi.fn(async () => undefined),
    claimOperation: vi.fn(async () => ({
      kind: "claimed" as const,
      operation: {
        status: "IN_PROGRESS" as const,
        referenceId: "abcdef123456",
        createdAt: now,
      },
    })),
    finishOperation: vi.fn(async () => true),
    audit,
    createReferenceId: () => "abcdef123456",
    ...overrides,
  };
}
