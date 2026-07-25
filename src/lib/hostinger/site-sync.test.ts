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
  decodeImportQueryResult,
  importVerifiedConfiguredSite,
  precheckConfiguredHostingerSite,
  selectExactWebsite,
  verifyConfiguredHostingerSite,
  type ImportQueryExecutor,
  type ImportStateQueryExecutor,
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
      code: "HOSTINGER_NOT_NODE",
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
  it("decodes the real drizzle-orm/neon-http full result shape", async () => {
    const actualAdapterResult = neonFullResult([
      importRow("imported"),
    ]);
    expect(decodeImportQueryResult(actualAdapterResult)).toEqual({
      type: "decoded",
      row: importRow("imported"),
    });

    const execute = vi
      .fn<ImportQueryExecutor>()
      .mockResolvedValue(actualAdapterResult);
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: execute,
        queryState: completeStateExecutor(),
      }),
    ).resolves.toEqual({
      type: "imported",
      siteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("accepts the documented direct Neon row-array result", async () => {
    const directRows = [importRow("imported")];
    expect(decodeImportQueryResult(directRows)).toEqual({
      type: "decoded",
      row: importRow("imported"),
    });
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: vi.fn().mockResolvedValue(directRows),
        queryState: completeStateExecutor(),
      }),
    ).resolves.toMatchObject({ type: "imported" });
  });

  it("distinguishes zero rows from malformed and multiple-row responses", () => {
    expect(decodeImportQueryResult(neonFullResult([]))).toEqual({
      type: "zero_rows",
    });
    expect(decodeImportQueryResult({ payload: [] })).toEqual({
      type: "malformed",
    });
    expect(
      decodeImportQueryResult([
        importRow("imported"),
        importRow("already_completed"),
      ]),
    ).toEqual({ type: "malformed" });
  });

  it("does not report success when the atomic database statement rolls back", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const execute = vi
      .fn<ImportQueryExecutor>()
      .mockRejectedValue(new Error("simulated transactional rollback"));
    const result = await importVerifiedConfiguredSite(
      "actor-1",
      verifiedSite,
      {
        executeImport: execute,
        queryState: stateExecutor(emptyState()),
      },
    );
    expect(result).toMatchObject({
      type: "persistence_failed",
      phase: "database_import",
      referenceId: expect.stringMatching(/^[A-F0-9]{12}$/),
    });
    expect(audit.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_failed",
        result: "FAILURE",
        metadata: expect.objectContaining({
          referenceId:
            result.type === "persistence_failed"
              ? result.referenceId
              : undefined,
          phase: "database_import",
        }),
      }),
    );
    consoleError.mockRestore();
  });

  it("uses the post-condition when the SQL response cannot be decoded", async () => {
    const execute = vi
      .fn<ImportQueryExecutor>()
      .mockResolvedValue({ unexpected: "driver payload" });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: execute,
        queryState: completeStateExecutor(),
      }),
    ).resolves.toEqual({
      type: "imported",
      siteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "hostinger_site_import_diagnostic",
      expect.objectContaining({
        phase: "result_decode",
        result: "postcondition_recovered",
      }),
    );
    consoleError.mockRestore();
  });

  it("returns a decode reference when the malformed response has no post-condition", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: vi.fn().mockResolvedValue({ rows: [{ nope: true }] }),
        queryState: stateExecutor(emptyState()),
      }),
    ).resolves.toMatchObject({
      type: "persistence_failed",
      phase: "result_decode",
      referenceId: expect.stringMatching(/^[A-F0-9]{12}$/),
    });
    consoleError.mockRestore();
  });

  it("does not trust a valid SQL result without the required post-condition", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: vi
          .fn()
          .mockResolvedValue(neonFullResult([importRow("imported")])),
        queryState: stateExecutor(emptyState()),
      }),
    ).resolves.toMatchObject({
      type: "persistence_failed",
      phase: "postcondition",
    });
    consoleError.mockRestore();
  });

  it.each([
    "target_site_count",
    "other_site_count",
    "username_match_count",
    "verified_node_match_count",
    "order_match_count",
    "owner_admin_membership_count",
    "owner_membership_count",
    "primary_binding_match_count",
    "primary_binding_count",
  ] as const)(
    "fails the post-condition when %s is inconsistent",
    async (field) => {
      const state = completeState();
      state[field] = field === "other_site_count" ? 1 : 0;
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await expect(
        importVerifiedConfiguredSite("actor-1", verifiedSite, {
          executeImport: vi
            .fn()
            .mockResolvedValue(neonFullResult([importRow("imported")])),
          queryState: stateExecutor(state),
        }),
      ).resolves.toMatchObject({
        type: "persistence_failed",
        phase: "postcondition",
      });
      consoleError.mockRestore();
    },
  );

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
        result = neonFullResult([
          importRow(first ? "imported" : "already_completed"),
        ]);
      });
      await chain;
      return result;
    };

    const results = await Promise.all([
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: execute,
        queryState: completeStateExecutor(),
      }),
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: execute,
        queryState: completeStateExecutor(),
      }),
    ]);
    expect(results.map((item) => item.type).sort()).toEqual([
      "already_imported",
      "imported",
    ]);
    expect(siteCount).toBe(1);
    expect(membershipCount).toBe(1);
  });

  it("fails closed for a different site and for unique violations", async () => {
    const conflict = vi
      .fn<ImportQueryExecutor>()
      .mockResolvedValue(
        neonFullResult([
          importRow("conflict", null, "different_site"),
        ]),
      );
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: conflict,
        queryState: stateExecutor({
          ...emptyState(),
          other_site_count: 1,
        }),
      }),
    ).resolves.toEqual({
      type: "single_site_conflict",
      reason: "different_site",
    });

    const uniqueViolation = vi
      .fn<ImportQueryExecutor>()
      .mockRejectedValue({ code: "23505" });
    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: uniqueViolation,
        queryState: stateExecutor(emptyState()),
      }),
    ).resolves.toEqual({
      type: "single_site_conflict",
      reason: "unique_violation",
    });
    expect(audit.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_conflict",
        metadata: { reason: "unique_violation" },
      }),
    );
  });

  it("recognizes an already completed OWNER state before Hostinger", async () => {
    const queryState = completeStateExecutor();
    await expect(
      precheckConfiguredHostingerSite("actor-1", {
        queryState,
        configuredSite: { domain: "example.com", username: "u1" },
      }),
    ).resolves.toEqual({
      type: "already_imported",
      siteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(audit.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_already_completed",
        result: "SUCCESS",
      }),
    );
  });

  it("does not leak tokens, error messages, or unrelated domains in logs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await importVerifiedConfiguredSite("actor-1", verifiedSite, {
      executeImport: vi.fn().mockRejectedValue(
        Object.assign(
          new Error(
            "Bearer secret-token for other-customer.com at postgresql://secret",
          ),
          {
            code: "23503",
            constraint: "sites_primary_domain_unique",
          },
        ),
      ),
      queryState: stateExecutor(emptyState()),
    });

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain("sites_primary_domain_unique");
    expect(logged).not.toMatch(
      /secret-token|other-customer\.com|postgresql:\/\/secret|example\.com/i,
    );
    consoleError.mockRestore();
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
    expect(source).toContain("FROM import_lock");
  });
});

function importRow(
  outcome: "imported" | "already_completed" | "conflict",
  siteId: string | null = "11111111-1111-4111-8111-111111111111",
  conflictReason:
    | "different_site"
    | "membership_conflict"
    | "username_conflict"
    | null = null,
) {
  return {
    outcome,
    site_id: siteId,
    conflict_reason: conflictReason,
  };
}

function completeState() {
  return {
    site_id: "11111111-1111-4111-8111-111111111111",
    target_site_count: 1,
    other_site_count: 0,
    username_match_count: 1,
    verified_node_match_count: 1,
    order_match_count: 1,
    owner_admin_membership_count: 1,
    owner_membership_count: 1,
    primary_binding_match_count: 1,
    primary_binding_count: 1,
  };
}

function emptyState() {
  return {
    site_id: null,
    target_site_count: 0,
    other_site_count: 0,
    username_match_count: 0,
    verified_node_match_count: 0,
    order_match_count: 0,
    owner_admin_membership_count: 0,
    owner_membership_count: 0,
    primary_binding_match_count: 0,
    primary_binding_count: 0,
  };
}

function neonFullResult(rows: unknown[]) {
  return {
    rows,
    fields: [],
    command: "SELECT",
    rowCount: rows.length,
    rowAsArray: false,
  };
}

function stateExecutor(
  state: ReturnType<typeof completeState> | ReturnType<typeof emptyState>,
) {
  return vi
    .fn<ImportStateQueryExecutor>()
    .mockResolvedValue(neonFullResult([state]));
}

function completeStateExecutor() {
  return stateExecutor(completeState());
}

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
