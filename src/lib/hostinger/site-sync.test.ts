import { PgDialect } from "drizzle-orm/pg-core";
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
  buildAtomicImportQuery,
  buildImportStateQuery,
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

  it("extracts SQLSTATE 42P18 from error.cause without exposing diagnostics", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const adapterError = Object.assign(
      new Error("adapter query and secret-token"),
      {
        query: "SELECT secret-token",
        parameters: ["secret-token", "other-customer.com"],
        connectionString: "postgresql://secret",
      },
    );
    const postgresError = Object.assign(
      new Error("could not determine data type of parameter $18"),
      {
        name: "PostgresError",
        code: "42P18",
        constraint: "audit_events_site_id_sites_id_fk",
        query: "SELECT secret-token",
        parameters: ["secret-token"],
        detail: "other-customer.com",
        stack: "postgresql://secret",
        cause: adapterError,
      },
    );
    Object.assign(adapterError, { cause: postgresError });

    await importVerifiedConfiguredSite("actor-1", verifiedSite, {
      executeImport: vi.fn().mockRejectedValue(adapterError),
      queryState: stateExecutor(emptyState()),
    });

    const diagnostic = consoleError.mock.calls[0][1];
    expect(diagnostic).toEqual(
      expect.objectContaining({
        postgresCode: "42P18",
        constraint: "audit_events_site_id_sites_id_fk",
        errorType: "Error",
      }),
    );
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toMatch(
      /adapter query|could not determine|secret-token|other-customer|SELECT|postgresql:\/\/|parameters|connectionString|stack/i,
    );
    consoleError.mockRestore();
  });

  it("does not log a constraint outside the diagnostic allowlist", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const wrapped = Object.assign(new Error("adapter"), {
      cause: {
        code: "23503",
        constraint: "customer_private_secret_constraint",
      },
    });

    await importVerifiedConfiguredSite("actor-1", verifiedSite, {
      executeImport: vi.fn().mockRejectedValue(wrapped),
      queryState: stateExecutor(emptyState()),
    });

    expect(consoleError.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        postgresCode: "23503",
        constraint: undefined,
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "customer_private_secret_constraint",
    );
    consoleError.mockRestore();
  });

  it("recognizes a wrapped unique violation without exposing its cause", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const wrapped = Object.assign(new Error("adapter secret-token"), {
      cause: { code: "23505", detail: "other-customer.com" },
    });

    await expect(
      importVerifiedConfiguredSite("actor-1", verifiedSite, {
        executeImport: vi.fn().mockRejectedValue(wrapped),
        queryState: stateExecutor(emptyState()),
      }),
    ).resolves.toEqual({
      type: "single_site_conflict",
      reason: "unique_violation",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /secret-token|other-customer\.com/i,
    );
    consoleError.mockRestore();
  });

  it("renders explicit PostgreSQL enum casts in every raw enum context", () => {
    const atomicSql = renderQuery(
      buildAtomicImportQuery({
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
        orderId: "order-1",
        correlationId: "corr-1",
      }),
    );
    const stateSql = renderQuery(
      buildImportStateQuery({
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
        orderId: "order-1",
      }),
    );
    const sqlText = `${atomicSql}\n${stateSql}`;

    expect(atomicSql.match(/'SUCCESS'::audit_result/g)).toHaveLength(1);
    expect(atomicSql.match(/'FAILURE'::audit_result/g)).toHaveLength(1);
    expect(sqlText).not.toMatch(
      /'(?:SUCCESS|FAILURE)'(?!::audit_result)/,
    );
    expect(sqlText).not.toMatch(/'ADMIN'(?!::membership_role)/);
    expect(sqlText).not.toMatch(/'VERIFIED'(?!::site_status)/);
  });

  it.each([
    {
      name: "a sanitized correlation ID",
      correlationId: "corr-1",
      expectedParameter: "corr-1",
    },
    {
      name: "an omitted correlation ID",
      correlationId: undefined,
      expectedParameter: null,
    },
  ])(
    "types the jsonb audit parameter as text with $name",
    ({ correlationId, expectedParameter }) => {
      const rendered = renderQueryWithParams(
        buildAtomicImportQuery({
          actorUserId: "11111111-1111-4111-8111-111111111111",
          domain: "example.com",
          username: "u1",
          orderId: "order-1",
          correlationId,
        }),
      );
      const correlationPlaceholder = rendered.sql.match(
        /'correlationId',\s*\$(\d+)::text/,
      );

      expect(correlationPlaceholder).not.toBeNull();
      expect(
        rendered.params[Number(correlationPlaceholder?.[1]) - 1],
      ).toBe(expectedParameter);
      expect(
        untypedPlaceholdersInFunction(
          rendered.sql,
          "jsonb_build_object",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    {
      name: "a Hostinger order ID",
      orderId: "order-1",
      expectedParameter: "order-1",
    },
    {
      name: "a null Hostinger order ID",
      orderId: undefined,
      expectedParameter: null,
    },
  ])(
    "keeps orderId text-typed in atomic and state queries with $name",
    ({ orderId, expectedParameter }) => {
      const input = {
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
        orderId,
      };
      const atomic = renderQueryWithParams(buildAtomicImportQuery(input));
      const state = renderQueryWithParams(buildImportStateQuery(input));

      const atomicOrderPlaceholder = atomic.sql.match(
        /SELECT\s+\$\d+,\s+\$\d+,\s+\$\d+,\s+\$(\d+),\s+true,\s+'VERIFIED'::site_status/,
      );
      const stateOrderPlaceholders = state.sql.match(
        /WHERE \$(\d+)::text IS NULL\s+OR hostinger_order_id = \$(\d+)::text/,
      );

      expect(atomicOrderPlaceholder).not.toBeNull();
      expect(
        atomic.params[Number(atomicOrderPlaceholder?.[1]) - 1],
      ).toBe(expectedParameter);
      expect(stateOrderPlaceholders).not.toBeNull();
      for (const placeholder of stateOrderPlaceholders?.slice(1) ?? []) {
        expect(state.params[Number(placeholder) - 1]).toBe(
          expectedParameter,
        );
      }
    },
  );

  it("keeps UUID and enum casts while avoiding untyped polymorphic parameters", () => {
    const atomicSql = renderQuery(
      buildAtomicImportQuery({
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
        correlationId: "corr-1",
      }),
    );
    const stateSql = renderQuery(
      buildImportStateQuery({
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
      }),
    );

    expect(atomicSql.match(/\$\d+::uuid/g)).toHaveLength(5);
    expect(stateSql.match(/\$\d+::uuid/g)).toHaveLength(2);
    expect(atomicSql).toContain("'SUCCESS'::audit_result");
    expect(atomicSql).toContain("'FAILURE'::audit_result");
    expect(atomicSql).toContain("'VERIFIED'::site_status");
    expect(atomicSql).toContain("'ADMIN'::membership_role");
    expect(stateSql).toContain("'VERIFIED'::site_status");
    expect(stateSql).toContain("'ADMIN'::membership_role");
    expect(
      untypedPlaceholdersInFunction(
        atomicSql,
        "jsonb_build_object",
      ),
    ).toEqual([]);
    expect(
      untypedPlaceholdersInFunction(
        stateSql,
        "jsonb_build_object",
      ),
    ).toEqual([]);
  });

  it("keeps every write and the advisory lock consumed by the final query", () => {
    const query = renderQuery(
      buildAtomicImportQuery({
        actorUserId: "11111111-1111-4111-8111-111111111111",
        domain: "example.com",
        username: "u1",
      }),
    );
    expect(query).toContain("pg_advisory_xact_lock");
    expect(query).toContain("WITH import_lock AS MATERIALIZED");
    expect(query).toContain("FROM import_lock");
    expect(query).toContain("FROM decision");
    expect(query).toContain("FROM site_write");
    expect(query).toContain("INNER JOIN membership_write");
    expect(query).toContain("INNER JOIN binding_write");
    expect(query).toContain("INNER JOIN audit_write");
    expect(query).toContain("ON CONFLICT ((lower(primary_domain)))");
    expect(query).toContain("ON CONFLICT (site_id, user_id)");
    expect(query).toContain(
      "ON CONFLICT (site_id, resource_type, external_id)",
    );
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

function renderQuery(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return new PgDialect().sqlToQuery(query).sql;
}

function renderQueryWithParams(
  query: Parameters<PgDialect["sqlToQuery"]>[0],
) {
  return new PgDialect().sqlToQuery(query);
}

function untypedPlaceholdersInFunction(
  sqlText: string,
  functionName: string,
) {
  const calls = sqlFunctionCalls(sqlText, functionName);
  return calls.flatMap(
    (call) =>
      call.match(
        /\$\d+(?!\d)(?!::[a-z_][a-z0-9_]*)/gi,
      ) ?? [],
  );
}

function sqlFunctionCalls(sqlText: string, functionName: string) {
  const calls: string[] = [];
  const lowerSql = sqlText.toLowerCase();
  const functionStart = `${functionName.toLowerCase()}(`;
  let searchFrom = 0;

  while (searchFrom < sqlText.length) {
    const start = lowerSql.indexOf(functionStart, searchFrom);
    if (start === -1) break;
    let depth = 0;
    let inString = false;

    for (let index = start; index < sqlText.length; index += 1) {
      const character = sqlText[index];
      if (character === "'") {
        if (inString && sqlText[index + 1] === "'") {
          index += 1;
          continue;
        }
        inString = !inString;
      } else if (!inString && character === "(") {
        depth += 1;
      } else if (!inString && character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(sqlText.slice(start, index + 1));
          searchFrom = index + 1;
          break;
        }
      }
    }

    if (searchFrom <= start) break;
  }

  return calls;
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
