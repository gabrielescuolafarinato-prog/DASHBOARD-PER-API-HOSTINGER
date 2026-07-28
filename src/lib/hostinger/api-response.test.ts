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

  it("returns only the safe reference ID for a malformed build response", async () => {
    const response = apiFailure(
      new AppError(
        "HOSTINGER_ERROR",
        "Hostinger returned an invalid response.",
        502,
        "corr-private",
        "a1b2c3d4e5f6",
      ),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "HOSTINGER_ERROR",
        message: "Hostinger returned an invalid response.",
        referenceId: "a1b2c3d4e5f6",
      },
    });
  });

  it("does not expose an invalid reference ID", async () => {
    const response = apiFailure(
      new AppError(
        "HOSTINGER_ERROR",
        "Hostinger returned an invalid response.",
        502,
        "corr-private",
        "raw-reference value",
      ),
    );

    expect(JSON.stringify(await response.json())).not.toContain(
      "raw-reference",
    );
  });

  it("returns a controlled 503 migration error without SQL details", async () => {
    const response = apiFailure(
      new AppError(
        "DATABASE_MIGRATION_REQUIRED",
        "Database update required.",
        503,
        undefined,
        "abcdef123456",
      ),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = JSON.stringify(await response.json());
    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: {
        code: "DATABASE_MIGRATION_REQUIRED",
        message: "Database update required.",
        referenceId: "abcdef123456",
      },
    });
    expect(body).not.toMatch(
      /select|insert|site_builds|build_state|postgresql:\/\//i,
    );
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
