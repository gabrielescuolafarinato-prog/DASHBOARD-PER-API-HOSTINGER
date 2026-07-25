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
});
