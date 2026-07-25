import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./domain";

describe("Hostinger domain normalization", () => {
  it.each([
    [" Example.COM. ", "example.com"],
    ["münich.example", "xn--mnich-kva.example"],
    ["sub.Example.com", "sub.example.com"],
  ])("normalizes %s to one canonical hostname", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    "https://example.com",
    "http://example.com",
    "example.com/path",
    "example.com?query=1",
    "example.com#fragment",
    "example.com:443",
    "user@example.com",
    "*.example.com",
    "example.com\n",
    "example.com\u0000",
    "example..com",
    " example .com ",
  ])("rejects non-hostname input %j", (input) => {
    expect(() => normalizeDomain(input)).toThrow();
  });

  it("does not collapse a subdomain or use partial matching", () => {
    expect(normalizeDomain("www.example.com")).toBe("www.example.com");
    expect(normalizeDomain("example.com.evil.test")).toBe(
      "example.com.evil.test",
    );
    expect(normalizeDomain("example.com.evil.test")).not.toBe(
      normalizeDomain("example.com"),
    );
  });
});
