import { describe, expect, it } from "vitest";
import { sanitizeAuditMetadata } from "./audit";

describe("audit metadata", () => {
  it("removes secret-bearing keys", () => {
    expect(
      sanitizeAuditMetadata({
        status: "ok",
        password: "never",
        authorization: "Bearer never",
      }),
    ).toEqual({ status: "ok" });
  });

  it("recursively redacts bearer values, connection strings and raw fields", () => {
    const sanitized = sanitizeAuditMetadata({
      result: "failure",
      nested: {
        token: "never",
        message: "Bearer should-never-appear",
        database: "postgresql://user:password@host/database",
        correlationId: "corr-1",
      },
      rawResponse: { sites: ["other-customer.com"] },
    });
    expect(sanitized).toEqual({
      result: "failure",
      nested: {
        message: "[REDACTED]",
        database: "[REDACTED]",
        correlationId: "corr-1",
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("should-never-appear");
    expect(JSON.stringify(sanitized)).not.toContain("other-customer.com");
  });
});
