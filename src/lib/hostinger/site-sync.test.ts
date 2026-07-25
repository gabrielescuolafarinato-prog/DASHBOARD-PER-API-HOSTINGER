import { describe, expect, it } from "vitest";
import { selectExactWebsite } from "./site-sync";

describe("Hostinger site selection", () => {
  it("discards websites with a different domain", () => {
    const result = selectExactWebsite("example.com", [
      { domain: "other.test", raw: {} },
      { domain: "EXAMPLE.COM.", raw: {} },
    ]);
    expect(result.domain).toBe("EXAMPLE.COM.");
  });

  it("fails on ambiguous exact matches", () => {
    expect(() =>
      selectExactWebsite("example.com", [
        { domain: "example.com", raw: {} },
        { domain: "www.example.com", raw: {} },
      ]),
    ).toThrow(/ambiguous/i);
  });
});
