import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  parseCacheClearRequest,
  parseCacheToggleRequest,
} from "./cache-input";

const key = "33333333-3333-4333-8333-333333333333";

describe("cache input boundary", () => {
  it("accepts only confirmed clear and strict boolean toggle bodies", async () => {
    await expect(
      parseCacheClearRequest(request({ confirmed: true })),
    ).resolves.toEqual({
      input: { confirmed: true },
      idempotencyKey: key,
    });
    await expect(
      parseCacheToggleRequest(
        request({ enabled: false, confirmed: true }),
      ),
    ).resolves.toEqual({
      input: { enabled: false, confirmed: true },
      idempotencyKey: key,
    });
  });

  it.each([
    { enabled: "true", confirmed: true },
    { enabled: true, confirmed: false },
    {
      enabled: true,
      confirmed: true,
      username: "browser-controlled",
    },
    {
      enabled: true,
      confirmed: true,
      domain: "other.example",
    },
    { enabled: true, confirmed: true, directory: "blog" },
  ])("rejects browser-controlled or malformed toggle input", async (body) => {
    await expect(
      parseCacheToggleRequest(request(body)),
    ).rejects.toBeDefined();
  });
});

function request(body: unknown) {
  return new NextRequest("https://console.test/api/cache/toggle", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
