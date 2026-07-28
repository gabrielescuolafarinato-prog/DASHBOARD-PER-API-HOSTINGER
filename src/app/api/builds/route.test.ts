import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  listBuildsForSite: vi.fn(),
  parseBuildListSearchParams: vi.fn(),
  requireNodeApiAccess: vi.fn(),
}));

vi.mock("@/lib/hostinger/build-service", () => ({
  listBuildsForSite: mocks.listBuildsForSite,
}));
vi.mock("@/lib/hostinger/build-input", () => ({
  parseBuildListSearchParams: mocks.parseBuildListSearchParams,
}));
vi.mock("@/lib/hostinger/api-access", () => ({
  requireNodeApiAccess: mocks.requireNodeApiAccess,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.listBuildsForSite.mockReset();
  mocks.parseBuildListSearchParams.mockReset();
  mocks.requireNodeApiAccess.mockReset();
  mocks.requireNodeApiAccess.mockResolvedValue({
    user: { id: "22222222-2222-4222-8222-222222222222" },
    site: {
      siteId: "11111111-1111-4111-8111-111111111111",
      primaryDomain: "private.example",
      hostingerUsername: "private-user",
      membershipRole: "MEMBER",
    },
  });
  mocks.parseBuildListSearchParams.mockReturnValue({
    page: 1,
    perPage: 25,
  });
});

describe("GET /api/builds", () => {
  it("returns a controlled malformed-response error with a reference ID", async () => {
    mocks.listBuildsForSite.mockRejectedValue(
      new AppError(
        "HOSTINGER_ERROR",
        "Hostinger returned an invalid response.",
        502,
        "corr-private",
        "a1b2c3d4e5f6",
      ),
    );

    const response = await GET(
      new NextRequest("https://console.test/api/builds?page=1&per_page=25"),
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

  it("returns a controlled 503 when the build migration is required", async () => {
    mocks.listBuildsForSite.mockRejectedValue(
      new AppError(
        "DATABASE_MIGRATION_REQUIRED",
        "Database update required.",
        503,
        undefined,
        "abcdef123456",
      ),
    );

    const response = await GET(
      new NextRequest("https://console.test/api/builds?page=1&per_page=25"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "DATABASE_MIGRATION_REQUIRED",
        message: "Database update required.",
        referenceId: "abcdef123456",
      },
    });
  });
});
