import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type {
  HostingerOperationClaim,
  HostingerOperationRecord,
} from "./operation-store";
import {
  claimHostingerOperation,
  finishHostingerOperation,
} from "./operation-store";
import {
  restartNodeServerForSite,
  type RestartAccessContext,
} from "./restart-service";

const siteId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const firstKey = "33333333-3333-4333-8333-333333333333";
const secondKey = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-07-29T10:00:00.000Z");
const audit = vi.fn(async () => undefined);

beforeEach(() => {
  audit.mockClear();
});

describe("site-scoped Node.js restart", () => {
  it.each([
    ["OWNER with ADMIN membership", "ADMIN"],
    ["COLLABORATOR with MEMBER membership", "MEMBER"],
  ] as const)("%s can restart with the same rights", async (
    _label,
    membershipRole,
  ) => {
    const store = fakeDurableStore();
    const client = {
      restartNodeServer: vi.fn(async () => ({
        restarted: true as const,
        correlationId: "corr-safe",
      })),
    };

    await expect(
      restartNodeServerForSite(context(membershipRole), firstKey, {
        client,
        claimOperation: store.claim,
        finishOperation: store.finish,
        audit,
        now: () => now,
        createReferenceId: () => "abcdef123456",
      }),
    ).resolves.toEqual({
      restarted: true,
      referenceId: "abcdef123456",
      idempotencyStatus: "created",
      cooldownEndsAt: "2026-07-29T10:00:30.000Z",
    });
    expect(client.restartNodeServer).toHaveBeenCalledWith(
      "db-hostinger-user",
      "db.example.com",
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_node_restart_requested",
        siteId,
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_node_restart_completed",
        result: "SUCCESS",
      }),
    );
  });

  it("replays the same idempotency key without calling Hostinger twice", async () => {
    const store = fakeDurableStore();
    const client = successfulClient();
    const dependencies = {
      client,
      claimOperation: store.claim,
      finishOperation: store.finish,
      audit,
      now: () => now,
      createReferenceId: () => "abcdef123456",
    };

    const first = await restartNodeServerForSite(
      context("ADMIN"),
      firstKey,
      dependencies,
    );
    const replay = await restartNodeServerForSite(
      context("MEMBER"),
      firstKey,
      dependencies,
    );

    expect(first.idempotencyStatus).toBe("created");
    expect(replay).toMatchObject({
      referenceId: first.referenceId,
      idempotencyStatus: "replayed",
    });
    expect(client.restartNodeServer).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_node_restart_duplicate",
      }),
    );
  });

  it("blocks two concurrent requests for the same site", async () => {
    const store = fakeDurableStore();
    let completeFirst: ((value: {
      restarted: true;
      correlationId: string;
    }) => void) | undefined;
    const client = {
      restartNodeServer: vi.fn(
        () =>
          new Promise<{
            restarted: true;
            correlationId: string;
          }>((resolve) => {
            completeFirst = resolve;
          }),
      ),
    };
    let reference = 0;
    const dependencies = {
      client,
      claimOperation: store.claim,
      finishOperation: store.finish,
      audit,
      now: () => now,
      createReferenceId: () => `abcde${String(reference++).padStart(7, "0")}`,
    };

    const first = restartNodeServerForSite(
      context("ADMIN"),
      firstKey,
      dependencies,
    );
    await vi.waitFor(() => {
      expect(client.restartNodeServer).toHaveBeenCalledOnce();
    });
    await expect(
      restartNodeServerForSite(
        context("MEMBER"),
        secondKey,
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      retryAfterSeconds: 5,
    });
    completeFirst?.({
      restarted: true,
      correlationId: "corr-first",
    });
    await expect(first).resolves.toMatchObject({ restarted: true });
    expect(client.restartNodeServer).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_node_restart_blocked",
        result: "DENIED",
      }),
    );
  });

  it("applies a durable site cooldown to a new key", async () => {
    const store = fakeDurableStore();
    const client = successfulClient();
    let reference = 0;
    const dependencies = {
      client,
      claimOperation: store.claim,
      finishOperation: store.finish,
      audit,
      now: () => now,
      createReferenceId: () => `fedcb${String(reference++).padStart(7, "0")}`,
    };

    await restartNodeServerForSite(
      context("ADMIN"),
      firstKey,
      dependencies,
    );
    await expect(
      restartNodeServerForSite(
        context("MEMBER"),
        secondKey,
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      retryAfterSeconds: 30,
    });
    expect(client.restartNodeServer).toHaveBeenCalledOnce();
  });

  it("audits a controlled failure and Hostinger rate limit without sensitive values", async () => {
    const store = fakeDurableStore();
    const client = {
      restartNodeServer: vi.fn(async () => {
        throw new AppError(
          "RATE_LIMITED",
          "Bearer secret-token private.example db-hostinger-user",
          429,
          "corr-safe",
        );
      }),
    };

    await expect(
      restartNodeServerForSite(context("MEMBER"), firstKey, {
        client,
        claimOperation: store.claim,
        finishOperation: store.finish,
        audit,
        now: () => now,
        createReferenceId: () => "abcdef123456",
      }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      referenceId: "abcdef123456",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_node_restart_failed",
        result: "FAILURE",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_rate_limited",
        metadata: expect.objectContaining({
          correlationId: "corr-safe",
          referenceId: "abcdef123456",
        }),
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /secret-token|private\.example|db-hostinger-user|Bearer|stack|https?:\/\//i,
    );
  });

  it.each([
    "https://private.example/correlation",
    "corr-db.example.com",
    "corr-db-hostinger-user",
  ])("drops an unsafe correlation ID before persistence and audit: %s", async (
    correlationId,
  ) => {
    const store = fakeDurableStore();
    const client = {
      restartNodeServer: vi.fn(async () => ({
        restarted: true as const,
        correlationId,
      })),
    };

    await restartNodeServerForSite(context("ADMIN"), firstKey, {
      client,
      claimOperation: store.claim,
      finishOperation: store.finish,
      audit,
      now: () => now,
      createReferenceId: () => "abcdef123456",
    });

    expect(store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: undefined }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(correlationId);
  });
});

function context(
  membershipRole: "ADMIN" | "MEMBER",
): RestartAccessContext {
  return {
    user: { id: actorId },
    site: {
      siteId,
      name: "Database site",
      primaryDomain: "db.example.com",
      hostingerUsername: "db-hostinger-user",
      membershipRole,
    },
  };
}

function successfulClient() {
  return {
    restartNodeServer: vi.fn(async () => ({
      restarted: true as const,
      correlationId: "corr-safe",
    })),
  };
}

function fakeDurableStore() {
  type ClaimInput = Parameters<typeof claimHostingerOperation>[0];
  type FinishInput = Parameters<typeof finishHostingerOperation>[0];
  const operations = new Map<
    string,
    HostingerOperationRecord
  >();

  const claim = vi.fn(
    async (input: ClaimInput): Promise<HostingerOperationClaim> => {
      const identity = `${input.siteId}:${input.operationType}:${input.idempotencyKeyHash}`;
      const existing = operations.get(identity);
      if (existing) {
        return { kind: "duplicate", operation: existing };
      }
      const recent = [...operations.values()].at(-1);
      if (recent) {
        return recent.status === "IN_PROGRESS"
          ? {
              kind: "blocked",
              reason: "in_progress",
              operation: recent,
            }
          : {
              kind: "blocked",
              reason: "cooldown",
              operation: recent,
            };
      }
      const operation: HostingerOperationRecord = {
        status: "IN_PROGRESS",
        referenceId: input.referenceId,
        createdAt: now,
      };
      operations.set(identity, operation);
      return { kind: "claimed", operation };
    },
  );

  const finish = vi.fn(async (input: FinishInput) => {
    const identity = `${input.siteId}:${input.operationType}:${input.idempotencyKeyHash}`;
    const operation = operations.get(identity);
    if (!operation || operation.status !== "IN_PROGRESS") return false;
    operation.status = input.status;
    operation.correlationId = input.correlationId;
    return true;
  });

  return { claim, finish };
}
