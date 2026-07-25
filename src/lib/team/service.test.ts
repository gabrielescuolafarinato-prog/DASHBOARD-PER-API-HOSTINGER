import { describe, expect, it, vi } from "vitest";
import { assertEmailAvailable, withAdministrativeAudit } from "./policy";

describe("team administration", () => {
  it("rejects duplicate users", () => {
    expect(() => assertEmailAvailable({ id: "existing" })).toThrow(
      /already exists/,
    );
  });

  it("writes a success audit only after an administrative mutation", async () => {
    const order: string[] = [];
    const audit = vi.fn(async (result: "SUCCESS" | "FAILURE") => {
      order.push(`audit:${result}`);
    });
    await withAdministrativeAudit(
      async () => {
        order.push("mutation");
        return true;
      },
      audit,
    );
    expect(order).toEqual(["mutation", "audit:SUCCESS"]);
  });
});
