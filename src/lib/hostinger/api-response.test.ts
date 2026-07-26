import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { apiFailure } from "./api-response";

describe("controlled build API errors", () => {
  it.each([
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["HOSTINGER_ERROR", 422],
    ["HOSTINGER_ERROR", 503],
    ["HOSTINGER_ERROR", 504],
  ] as const)("returns a minimal %s response with status %i", async (code, status) => {
    const response = apiFailure(
      new AppError(code, "Controlled message", status, "corr-1"),
    );
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code, message: "Controlled message" },
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns retry guidance and a Retry-After header for 429", async () => {
    const response = apiFailure(
      new AppError("RATE_LIMITED", "raw body", 429, "corr-1"),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message:
          "Hostinger is temporarily rate limited. Retry in a few moments.",
        retryAfterSeconds: 30,
      },
    });
  });

  it("does not expose unknown errors, stacks or raw responses", async () => {
    const response = apiFailure(
      new Error(
        "Bearer secret-token raw Hostinger response postgresql://secret",
      ),
    );
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(body).not.toMatch(
      /secret-token|raw Hostinger|postgresql:\/\/|stack/i,
    );
  });
});
