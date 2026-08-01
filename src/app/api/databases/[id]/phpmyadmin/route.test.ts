import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireHostingerApiAccess: vi.fn(),
  parseDatabaseId: vi.fn(),
  parseEmptyDatabaseSearchParams: vi.fn(),
  getPhpMyAdminLinkForSite: vi.fn(),
}));

vi.mock("@/lib/hostinger/api-access", () => ({
  requireHostingerApiAccess: mocks.requireHostingerApiAccess,
}));
vi.mock("@/lib/hostinger/database-input", () => ({
  parseDatabaseId: mocks.parseDatabaseId,
  parseEmptyDatabaseSearchParams:
    mocks.parseEmptyDatabaseSearchParams,
}));
vi.mock("@/lib/hostinger/database-service", () => ({
  getPhpMyAdminLinkForSite: mocks.getPhpMyAdminLinkForSite,
}));

import { GET } from "./route";

const databaseId = "44444444-4444-4444-8444-444444444444";
const referenceId = "abcdef123456";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.parseDatabaseId.mockReturnValue(databaseId);
  mocks.getPhpMyAdminLinkForSite.mockResolvedValue({
    link: "https://auth-db123.hostinger.com/signon.php?sid=safe",
    referenceId,
  });
});

describe("GET /api/databases/[id]/phpmyadmin", () => {
  it.each(["ADMIN", "MEMBER"] as const)(
    "gives %s the same site-scoped access",
    async (membershipRole) => {
      const current = context(membershipRole);
      mocks.requireHostingerApiAccess.mockResolvedValue(current);

      const response = await GET(request(), routeContext());

      expect(response.status).toBe(200);
      expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
        "database.phpmyadmin.link",
      );
      expect(mocks.getPhpMyAdminLinkForSite).toHaveBeenCalledWith(
        current,
        databaseId,
      );
      expect(response.headers.get("cache-control")).toContain(
        "private, no-store",
      );
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("referrer-policy")).toBe(
        "no-referrer",
      );
      expect(response.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
    },
  );

  it("returns the safe reference ID without exposing upstream data", async () => {
    mocks.requireHostingerApiAccess.mockResolvedValue(context("ADMIN"));
    mocks.getPhpMyAdminLinkForSite.mockRejectedValue(
      new AppError(
        "HOSTINGER_ERROR",
        "Hostinger returned an invalid phpMyAdmin link response.",
        502,
        "corr-private",
        referenceId,
        undefined,
        "PHPMYADMIN_LOCAL_HOSTNAME",
      ),
    );

    const response = await GET(request(), routeContext());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "HOSTINGER_ERROR",
        message:
          "Hostinger returned an invalid phpMyAdmin link response.",
        referenceId,
        diagnosticCode: "PHPMYADMIN_LOCAL_HOSTNAME",
      },
    });
  });
});

function context(membershipRole: "ADMIN" | "MEMBER") {
  return {
    user: { id: "22222222-2222-4222-8222-222222222222" },
    site: {
      siteId: "11111111-1111-4111-8111-111111111111",
      name: "Site",
      primaryDomain: "example.com",
      hostingerUsername: "u123",
      membershipRole,
    },
  };
}

function request() {
  return new NextRequest(
    `https://console.test/api/databases/${databaseId}/phpmyadmin`,
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: databaseId }) };
}
