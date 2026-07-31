import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_COOLDOWN_SECONDS,
  clearCacheForSite,
  toggleCacheForSite,
  toggleCachelessModeForSite,
} from "./cache-service";

const siteId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const audit = vi.fn(async () => undefined);
const finishOperation = vi.fn(async () => true);
const claimOperation = vi.fn(async () => ({
  kind: "claimed" as const,
  operation: {
    status: "IN_PROGRESS" as const,
    referenceId: "abcdef123456",
    createdAt: new Date("2026-07-31T10:00:00Z"),
  },
}));

beforeEach(() => {
  audit.mockClear();
  finishOperation.mockClear();
  claimOperation.mockClear();
});

describe("site-scoped cache service", () => {
  it.each(["ADMIN", "MEMBER"] as const)(
    "grants %s the same clear-cache mutation",
    async (role) => {
      const clearWebsiteCache = vi.fn(async () => ({
        accepted: true as const,
        correlationId: "corr-cache",
      }));
      await expect(
        clearCacheForSite(context(role), idempotencyKey, {
          client: {
            clearWebsiteCache,
            toggleWebsiteCache: vi.fn(),
            toggleWebsiteCachelessMode: vi.fn(),
          },
          claimOperation,
          finishOperation,
          audit,
          createReferenceId: () => "abcdef123456",
        }),
      ).resolves.toMatchObject({
        accepted: true,
        idempotencyStatus: "created",
      });
      expect(clearWebsiteCache).toHaveBeenCalledWith(
        "u123",
        "example.com",
      );
    },
  );

  it("uses one shared durable resource lock and cooldown for incompatible cache operations", async () => {
    const client = {
      clearWebsiteCache: vi.fn(),
      toggleWebsiteCache: vi.fn(async () => ({
        accepted: true as const,
      })),
      toggleWebsiteCachelessMode: vi.fn(async () => ({
        accepted: true as const,
      })),
    };
    const dependencies = {
      client,
      claimOperation,
      finishOperation,
      audit,
      createReferenceId: () => "abcdef123456",
    };
    await toggleCacheForSite(
      context("ADMIN"),
      true,
      idempotencyKey,
      dependencies,
    );
    await toggleCachelessModeForSite(
      context("MEMBER"),
      false,
      "44444444-4444-4444-8444-444444444444",
      dependencies,
    );

    expect(client.toggleWebsiteCache).toHaveBeenCalledWith(
      "u123",
      "example.com",
      true,
    );
    expect(client.toggleWebsiteCachelessMode).toHaveBeenCalledWith(
      "u123",
      "example.com",
      false,
    );
    const claims = claimOperation.mock.calls as unknown as Array<
      [
        {
          resourceKeyHash?: string;
          cooldownSeconds?: number;
        },
      ]
    >;
    const firstClaim = claims[0]?.[0];
    const secondClaim = claims[1]?.[0];
    expect(firstClaim?.resourceKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondClaim?.resourceKeyHash).toBe(
      firstClaim?.resourceKeyHash,
    );
    expect(firstClaim?.cooldownSeconds).toBe(
      CACHE_COOLDOWN_SECONDS,
    );
    expect(secondClaim?.cooldownSeconds).toBe(
      CACHE_COOLDOWN_SECONDS,
    );
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /u123|example\.com/i,
    );
  });

  it("replays a completed idempotency key without another Hostinger call", async () => {
    const toggleWebsiteCache = vi.fn();
    await expect(
      toggleCacheForSite(context("ADMIN"), false, idempotencyKey, {
        client: {
          clearWebsiteCache: vi.fn(),
          toggleWebsiteCache,
          toggleWebsiteCachelessMode: vi.fn(),
        },
        claimOperation: vi.fn(async () => ({
          kind: "duplicate" as const,
          operation: {
            status: "SUCCEEDED" as const,
            referenceId: "abcdef123456",
            createdAt: new Date(),
          },
        })),
        audit,
      }),
    ).resolves.toMatchObject({ idempotencyStatus: "replayed" });
    expect(toggleWebsiteCache).not.toHaveBeenCalled();
  });

  it("blocks a cache operation during a durable cooldown", async () => {
    const toggleWebsiteCachelessMode = vi.fn();
    await expect(
      toggleCachelessModeForSite(
        context("MEMBER"),
        true,
        idempotencyKey,
        {
          client: {
            clearWebsiteCache: vi.fn(),
            toggleWebsiteCache: vi.fn(),
            toggleWebsiteCachelessMode,
          },
          claimOperation: vi.fn(async () => ({
            kind: "blocked" as const,
            reason: "cooldown" as const,
            operation: {
              status: "SUCCEEDED" as const,
              referenceId: "abcdef123456",
              createdAt: new Date(),
            },
          })),
          audit,
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      retryAfterSeconds: CACHE_COOLDOWN_SECONDS,
    });
    expect(toggleWebsiteCachelessMode).not.toHaveBeenCalled();
  });
});

function context(membershipRole: "ADMIN" | "MEMBER") {
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
