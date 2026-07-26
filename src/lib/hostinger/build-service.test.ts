import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { NodeBuildPage } from "./client";
import {
  getBuildLogsForSite,
  listBuildsForSite,
  type BoundSiteBuild,
  type BuildAccessContext,
} from "./build-service";

const buildUuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";
const siteId = "11111111-1111-4111-8111-111111111111";

const buildPage: NodeBuildPage = {
  builds: [
    {
      uuid: buildUuid,
      state: "completed",
      origin: "archive",
      createdAt: "2024-05-29T05:49:49.067239Z",
      updatedAt: "2024-05-29T05:50:49.067239Z",
    },
  ],
  pagination: {
    page: 1,
    perPage: 25,
    total: 1,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  },
  correlationId: "corr-1",
};

const audit = vi.fn(async () => undefined);
const syncBuilds = vi.fn(async () => undefined);

beforeEach(() => {
  audit.mockClear();
  syncBuilds.mockClear();
});

describe("site-scoped build reads", () => {
  it.each([
    ["OWNER with ADMIN membership", "ADMIN"],
    ["COLLABORATOR with MEMBER membership", "MEMBER"],
  ] as const)("%s can list builds", async (_name, membershipRole) => {
    const client = fakeClient();
    await expect(
      listBuildsForSite(context(membershipRole), { page: 1, perPage: 25 }, {
        client,
        syncBuilds,
        audit,
      }),
    ).resolves.toEqual({
      builds: buildPage.builds,
      pagination: buildPage.pagination,
    });
    expect(client.listNodeBuilds).toHaveBeenCalledWith(
      "db-hostinger-user",
      "db.example.com",
      { page: 1, perPage: 25 },
    );
    expect(syncBuilds).toHaveBeenCalledWith(siteId, buildPage.builds);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "node_builds_list_read",
        result: "SUCCESS",
        siteId,
      }),
    );
  });

  it("uses only the authoritative database site identity", async () => {
    const client = fakeClient();
    await listBuildsForSite(context("MEMBER"), { page: 3, perPage: 10 }, {
      client,
      syncBuilds,
      audit,
    });
    const serialized = JSON.stringify(client.listNodeBuilds.mock.calls);
    expect(serialized).toContain("db-hostinger-user");
    expect(serialized).toContain("db.example.com");
    expect(serialized).not.toMatch(/browser-user|attacker\.example/);
  });

  it("denies a valid UUID that is not bound to the membership site", async () => {
    const client = fakeClient();
    await expect(
      getBuildLogsForSite(
        context("MEMBER"),
        { uuid: buildUuid, fromLine: 0 },
        {
          client,
          findBuild: vi.fn(async () => undefined),
          audit,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(client.getNodeBuildLogs).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_access_denied",
        result: "DENIED",
        targetIdentifier: buildUuid,
      }),
    );
  });

  it("retrieves incremental logs with from_line and never audits log content", async () => {
    const client = fakeClient({
      logs:
        "\u001b[31mBearer never-show\u001b[0m password=hunter2 postgresql://u:p@db/app",
      lines: 15,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const result = await getBuildLogsForSite(
      context("ADMIN"),
      { uuid: buildUuid, fromLine: 10 },
      {
        client,
        findBuild: boundBuild,
        audit,
      },
    );

    expect(client.getNodeBuildLogs).toHaveBeenCalledWith(
      "db-hostinger-user",
      "db.example.com",
      buildUuid,
      10,
    );
    expect(result).toMatchObject({
      fromLine: 10,
      nextFromLine: 15,
      polling: false,
    });
    expect(result.content).toContain("Bearer [REDACTED]");
    expect(result.content).toContain("password=[REDACTED]");
    expect(result.content).toContain("[REDACTED_CONNECTION_STRING]");
    expect(result.content).not.toMatch(/never-show|hunter2|postgresql:\/\//);
    const auditPayload = JSON.stringify(audit.mock.calls);
    expect(auditPayload).not.toMatch(
      /never-show|hunter2|postgresql:\/\/|Bearer \[REDACTED\]/,
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /never-show|hunter2|postgresql:\/\//,
    );
    consoleError.mockRestore();
  });

  it("refreshes an active build state and stops polling when it terminates", async () => {
    const client = fakeClient();
    await expect(
      getBuildLogsForSite(
        context("MEMBER"),
        { uuid: buildUuid, fromLine: 0 },
        {
          client,
          findBuild: vi.fn(async () => ({
            uuid: buildUuid,
            state: "running" as const,
          })),
          syncBuilds,
          audit,
        },
      ),
    ).resolves.toMatchObject({
      build: { uuid: buildUuid, state: "completed" },
      polling: false,
    });
    expect(client.listNodeBuilds).toHaveBeenCalledWith(
      "db-hostinger-user",
      "db.example.com",
      { page: 1, perPage: 100 },
    );
  });

  it("audits rate limiting without response bodies or secrets", async () => {
    const client = fakeClient();
    client.listNodeBuilds.mockRejectedValueOnce(
      new AppError(
        "RATE_LIMITED",
        "body with Bearer secret-must-not-be-audited",
        429,
        "corr-safe",
      ),
    );
    await expect(
      listBuildsForSite(context("ADMIN"), { page: 1, perPage: 25 }, {
        client,
        syncBuilds,
        audit,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_rate_limited",
        metadata: expect.objectContaining({
          correlationId: "corr-safe",
          status: 429,
        }),
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(
      "secret-must-not-be-audited",
    );
  });
});

function context(
  membershipRole: "ADMIN" | "MEMBER",
): BuildAccessContext {
  return {
    user: { id: "22222222-2222-4222-8222-222222222222" },
    site: {
      siteId,
      name: "Database site",
      primaryDomain: "db.example.com",
      hostingerUsername: "db-hostinger-user",
      membershipRole,
    },
  };
}

async function boundBuild(): Promise<BoundSiteBuild> {
  return {
    uuid: buildUuid,
    state: "completed",
    origin: "archive",
  };
}

function fakeClient(logs = { logs: "", lines: 0 }) {
  return {
    listNodeBuilds: vi.fn(async () => buildPage),
    getNodeBuildLogs: vi.fn(async () => ({
      ...logs,
      correlationId: "corr-logs",
    })),
  };
}
