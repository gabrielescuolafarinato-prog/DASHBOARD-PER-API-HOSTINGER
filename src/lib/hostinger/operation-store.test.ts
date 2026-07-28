import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildOperationClaimQuery,
  claimHostingerOperation,
  decodeOperationClaim,
} from "./operation-store";

describe("durable Hostinger operation claims", () => {
  it("serializes each site operation with a transaction advisory lock", () => {
    const rendered = new PgDialect().sqlToQuery(
      buildOperationClaimQuery({
        siteId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "22222222-2222-4222-8222-222222222222",
        operationType: "node.restart",
        idempotencyKeyHash: "a".repeat(64),
        referenceId: "abcdef123456",
      }),
    );

    expect(rendered.sql).toContain("pg_advisory_xact_lock");
    expect(rendered.sql).toContain("WITH operation_lock AS MATERIALIZED");
    expect(rendered.sql).toContain("INNER JOIN operation_lock ON true");
    expect(rendered.sql).toContain("INSERT INTO hostinger_operations");
    expect(rendered.sql).toContain("ON CONFLICT DO NOTHING");
    expect(rendered.sql).toContain("existing_operation");
    expect(rendered.sql).toContain("recent_operation");
    expect(rendered.sql).not.toMatch(/token|payload|response|domain|username/i);
  });

  it.each([
    ["CLAIMED", { kind: "claimed" }],
    ["DUPLICATE", { kind: "duplicate" }],
    [
      "IN_PROGRESS",
      { kind: "blocked", reason: "in_progress" },
    ],
    ["COOLDOWN", { kind: "blocked", reason: "cooldown" }],
  ] as const)("decodes the controlled %s outcome", (outcome, expected) => {
    expect(
      decodeOperationClaim([
        {
          outcome,
          status:
            outcome === "CLAIMED" || outcome === "IN_PROGRESS"
              ? "IN_PROGRESS"
              : "SUCCEEDED",
          reference_id: "abcdef123456",
          correlation_id: "corr-safe",
          created_at_epoch: 1_785_318_400,
        },
      ]),
    ).toMatchObject(expected);
  });

  it("re-reads a conflict after a concurrent insert used an older statement snapshot", async () => {
    const operation = {
      status: "IN_PROGRESS" as const,
      referenceId: "abcdef123456",
      createdAt: new Date("2026-07-29T10:00:00.000Z"),
    };
    const lookupConflict = async () =>
      ({
        kind: "blocked",
        reason: "in_progress",
        operation,
      }) as const;

    await expect(
      claimHostingerOperation(
        {
          siteId: "11111111-1111-4111-8111-111111111111",
          actorUserId: "22222222-2222-4222-8222-222222222222",
          operationType: "node.restart",
          idempotencyKeyHash: "a".repeat(64),
          referenceId: "123456abcdef",
        },
        {
          expireStale: async () => undefined,
          execute: async () => [],
          lookupConflict,
        },
      ),
    ).resolves.toEqual({
      kind: "blocked",
      reason: "in_progress",
      operation,
    });
  });

  it.each([
    { result: [] },
    { result: [{ outcome: "CLAIMED" }] },
    {
      result: [
        {
          outcome: "CLAIMED",
          status: "IN_PROGRESS",
          reference_id: "unsafe reference",
          correlation_id: null,
          created_at_epoch: 1,
        },
      ],
    },
  ])("rejects a malformed operation claim result", ({ result }) => {
    expect(() => decodeOperationClaim(result)).toThrow(
      "Hostinger operation claim returned an invalid result.",
    );
  });
});
