import { describe, expect, it } from "vitest";
import {
  parseBuildListSearchParams,
  parseBuildLogSearchParams,
} from "./build-input";

describe("build request input", () => {
  it("accepts valid pagination and applies bounded defaults", () => {
    expect(parseBuildListSearchParams(new URLSearchParams())).toEqual({
      page: 1,
      perPage: 25,
    });
    expect(
      parseBuildListSearchParams(
        new URLSearchParams({ page: "12", per_page: "100" }),
      ),
    ).toEqual({ page: 12, perPage: 100 });
  });

  it.each([
    { page: "0" },
    { page: "10001" },
    { page: "1.5" },
    { per_page: "0" },
    { per_page: "101" },
    { per_page: "all" },
  ])("rejects out-of-bound pagination %#", (query) => {
    expect(() =>
      parseBuildListSearchParams(
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string",
          ),
        ),
      ),
    ).toThrow();
  });

  it("does not let the browser supply a username, domain or Hostinger path", () => {
    for (const key of ["username", "domain", "path", "method", "order_id"]) {
      expect(() =>
        parseBuildListSearchParams(
          new URLSearchParams({ page: "1", [key]: "attacker-value" }),
        ),
      ).toThrow();
    }
  });

  it("validates UUID and from_line bounds", () => {
    const uuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";
    expect(
      parseBuildLogSearchParams(
        uuid,
        new URLSearchParams({ from_line: "42" }),
      ),
    ).toEqual({ uuid, fromLine: 42 });
    expect(() =>
      parseBuildLogSearchParams(
        uuid,
        new URLSearchParams({ from_line: "-1" }),
      ),
    ).toThrow();
    expect(() =>
      parseBuildLogSearchParams("another-site-build", new URLSearchParams()),
    ).toThrow();
  });
});
