import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostingerClient } from "./client";

const audit = vi.hoisted(() => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  writeAuditEvent: audit.writeAuditEvent,
  hashAuditIdentifier: (value?: string) =>
    value ? `hash:${value.toLowerCase()}` : undefined,
}));

import {
  importVerifiedConfiguredSite,
  selectExactWebsite,
  verifyConfiguredHostingerSite,
  type ImportQueryExecutor,
  type VerifiedConfiguredSite,
} from "./site-sync";

const originalEnvironment = {
  HOSTINGER_API_TOKEN: process.env.HOSTINGER_API_TOKEN,
  HOSTINGER_ACCOUNT_USERNAME: process.env.HOSTINGER_ACCOUNT_USERNAME,
  HOSTINGER_SITE_DOMAIN: process.env.HOSTINGER_SITE_DOMAIN,
};

const verifiedSite: VerifiedConfiguredSite = {
  domain: "example.com",
  username: "u1",
  orderId: "order-1",
  siteStatus: "VERIFIED",
  nodeEnabled: true,
  correlationId: "corr-1",
};

beforeEach(() => {
  process.env.HOSTINGER_API_TOKEN = "mock-token";
  process.env.HOSTINGER_ACCOUNT_USERNAME = "u1";
  process.env.HOSTINGER_SITE_DOMAIN = "Example.COM.";
  audit.writeAuditEvent.mockReset();
  audit.writeAuditEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  restore("HOSTINGER_API_TOKEN", originalEnvironment.HOSTINGER_API_TOKEN);
  restore(
    "HOSTINGER_ACCOUNT_USERNAME",
    originalEnvironment.HOSTINGER_ACCOUNT_USERNAME,
  );
  restore(
    "HOSTINGER_SITE_DOMAIN",
    originalEnvironment.HOSTINGER_SITE_DOMAIN,
  );
});

describe("Hostinger site selection and verification", () => {
  it("selects only the exact normalized domain and exact username", () => {
    const result = selectExactWebsite("example.com", "u1", [
      { domain: "other.test", username: "u1" },
      { domain: "example.com.evil.test", username: "u1" },
      { domain: "EXAMPLE.COM.", username: "u1", orderId: "correct" },
      { domain: "example.com", username: "other" },
    ]);
    expect(result).toEqual({
      domain: "EXAMPLE.COM.",
      username: "u1",
      orderId: "correct",
    });
  });

  it("fails closed on zero and multiple exact matches", () => {
    expect(() => selectExactWebsite("example.com", "u1", [])).toThrow(
      /not found/i,
    );
    expect(() =>
      selectExactWebsite("example.com", "u1", [
        { domain: "example.com", username: "u1" },
        { domain: "EXAMPLE.COM.", username: "u1" },
      ]),
    ).toThrow(/ambiguous/i);
  });

  it("verifies discovery and Node.js without returning builds or username to the action payload", async () => {
    const client = fakeClient({
      matches: [
        {
          domain: "example.com",
          username: "u1",
          orderId: "order-1",
        },
      ],
      buildCount: 0,
    });

    await expect(
      verifyConfiguredHostingerSite("actor-1", client),
    ).resolves.toEqual(verifiedSite);
    expect(client.listWebsitesForConfiguredSite).toHaveBeenCalledWith(
      "example.com",
      "u1",
    );
    expect(client.verifyConfiguredNodeSite).toHaveBeenCalledWith(
      "u1",
      "example.com",
    );
    expect(audit.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_verification_started",
      }),
    );
  });

  it("treats a non-empty build response as Node.js capability only", async () => {
    const client = fakeClient({
      matches: [{ domain: "example.com", username: "u1" }],
      buildCount: 3,
    });
    const result = await verifyConfiguredHostingerSite("actor-1", client);
    expect(result.nodeEnabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("build");
  });

  it("maps a missing Node endpoint to a controlled non-Node.js result", async () => {
    const client = fakeClient({
      matches: [{ domain: "example.com", username: "u1" }],
      nodeError: Object.assign(new Error("not found"), {
        name: "AppError",
        code: "NOT_FOUND",
        status: 404,
      }),
    });
    const { AppError } = await import("@/lib/errors");
    client.verifyConfiguredNodeSite.mockRejectedValue(
      new AppError("NOT_FOUND", "not found", 404, "corr-node"),
    );

    await expect(
      verifyConfiguredHostingerSite("actor-1", client),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 422,
      correlationId: "corr-node",
    });
    expect(audit.writeAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_verification_failed",
        metadata: expect.objectContaining({
          correlationId: "corr-node",
        }),
      }),
    );
  });

  it("never places unrelated sites in audit arguments", async () => {
    const client = fakeClient({
      matches: [{ domain: "example.com", username: "u1" }],
      buildCount: 0,
    });
    await verifyConfiguredHostingerSite("actor-1", client);
    const auditPayload = JSON.stringify(audit.writeAuditEvent.mock.calls);
    expect(auditPayload).not.toContain("other-customer.com");
    expect(auditPayload).not.toContain("example.com.evil.test");
    expect(auditPayload).not.toContain("mock-token");
  });
});

describe("atomic Hostinger site import", () => {
  it("returns an imported site from one atomic query", async () => {
    const execute = vi.fn<ImportQueryExecutor>().mockResolvedValue({
      rows: [
        {
          outcome: "imported",
          site_id: "11111111-1111-4111-8111-111111111111",
          conflict_reason: null,
        },
      ],
    });
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, execute),
    ).resolves.toEqual({
      outcome: "imported",
      siteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not report success when the atomic database statement rolls back", async () => {
    const execute = vi
      .fn<ImportQueryExecutor>()
      .mockRejectedValue(new Error("simulated transactional rollback"));
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, execute),
    ).rejects.toThrow(/rollback/);
  });

  it("is idempotent for the same OWNER and verified site", async () => {
    const execute = vi
      .fn<ImportQueryExecutor>()
      .mockResolvedValueOnce({
        rows: [
          {
            outcome: "imported",
            site_id: "11111111-1111-4111-8111-111111111111",
            conflict_reason: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            outcome: "already_completed",
            site_id: "11111111-1111-4111-8111-111111111111",
            conflict_reason: null,
          },
        ],
      });

    const first = await importVerifiedConfiguredSite(
      "actor-1",
      verifiedSite,
      execute,
    );
    const second = await importVerifiedConfiguredSite(
      "actor-1",
      verifiedSite,
      execute,
    );
    expect([first.outcome, second.outcome]).toEqual([
      "imported",
      "already_completed",
    ]);
    expect(first.siteId).toBe(second.siteId);
  });

  it("serializes two concurrent imports into one site and one membership", async () => {
    let chain = Promise.resolve();
    let siteCount = 0;
    let membershipCount = 0;
    const execute: ImportQueryExecutor = async () => {
      let result: unknown;
      chain = chain.then(async () => {
        await Promise.resolve();
        const first = siteCount === 0;
        if (first) {
          siteCount = 1;
          membershipCount = 1;
        }
        result = {
          rows: [
            {
              outcome: first ? "imported" : "already_completed",
              site_id: "11111111-1111-4111-8111-111111111111",
              conflict_reason: null,
            },
          ],
        };
      });
      await chain;
      return result;
    };

    const results = await Promise.all([
      importVerifiedConfiguredSite("actor-1", verifiedSite, execute),
      importVerifiedConfiguredSite("actor-1", verifiedSite, execute),
    ]);
    expect(results.map((item) => item.outcome).sort()).toEqual([
      "already_completed",
      "imported",
    ]);
    expect(siteCount).toBe(1);
    expect(membershipCount).toBe(1);
  });

  it("fails closed for a different site and for unique violations", async () => {
    const conflict = vi.fn<ImportQueryExecutor>().mockResolvedValue({
      rows: [
        {
          outcome: "conflict",
          site_id: null,
          conflict_reason: "different_site",
        },
      ],
    });
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, conflict),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

    const uniqueViolation = vi
      .fn<ImportQueryExecutor>()
      .mockRejectedValue({ code: "23505" });
    await expect(
      importVerifiedConfiguredSite(
        "actor-1",
        verifiedSite,
        uniqueViolation,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(audit.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_conflict",
        metadata: { reason: "unique_violation" },
      }),
    );
  });

  it("keeps all writes, lock and required audit operations in the atomic statement", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/hostinger/site-sync.ts"),
      "utf8",
    );
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("WITH import_lock AS MATERIALIZED");
    expect(source).toContain("INSERT INTO sites");
    expect(source).toContain("INSERT INTO site_memberships");
    expect(source).toContain("INSERT INTO hostinger_resource_bindings");
    expect(source).toContain("INSERT INTO audit_events");
    expect(source).toContain("hostinger_site_imported");
    expect(source).toContain("hostinger_site_import_already_completed");
    expect(source).toContain("hostinger_site_import_conflict");
    expect(source).not.toContain("console.");
  });
});

function fakeClient(input: {
  matches: Array<{ domain: string; username: string; orderId?: string }>;
  buildCount?: number;
  nodeError?: unknown;
}) {
  return {
    listWebsitesForConfiguredSite: vi.fn().mockResolvedValue({
      matches: input.matches,
      correlationId: "corr-1",
    }),
    verifyConfiguredNodeSite: input.nodeError
      ? vi.fn().mockRejectedValue(input.nodeError)
      : vi.fn().mockResolvedValue({
          nodeEnabled: true,
          buildCount: input.buildCount ?? 0,
          correlationId: "corr-1",
        }),
  } as unknown as HostingerClient & {
    listWebsitesForConfiguredSite: ReturnType<typeof vi.fn>;
    verifyConfiguredNodeSite: ReturnType<typeof vi.fn>;
  };
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
