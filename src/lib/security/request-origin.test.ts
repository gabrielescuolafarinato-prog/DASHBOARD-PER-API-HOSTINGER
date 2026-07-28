import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { assertTrustedMutationRequest } from "./request-origin";

describe("mutation request origin boundary", () => {
  it("accepts an exact allowlisted same-origin request", () => {
    const request = new NextRequest(
      "https://console.test/api/node/restart",
      {
        method: "POST",
        headers: {
          Origin: "https://console.test",
          "Sec-Fetch-Site": "same-origin",
        },
      },
    );
    expect(() =>
      assertTrustedMutationRequest(request, ["https://console.test"]),
    ).not.toThrow();
  });

  it.each([
    [undefined, undefined],
    ["https://attacker.test", "cross-site"],
    ["https://console.test/path", "same-origin"],
    ["https://preview.console.test", "same-site"],
  ])("rejects invalid origin %s", (origin, fetchSite) => {
    const headers = new Headers();
    if (origin) headers.set("Origin", origin);
    if (fetchSite) headers.set("Sec-Fetch-Site", fetchSite);
    const request = new NextRequest(
      "https://console.test/api/node/restart",
      { method: "POST", headers },
    );
    expect(() =>
      assertTrustedMutationRequest(request, [
        "https://console.test",
        "https://preview.console.test",
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });
});
