import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  assertTrustedMutationRequest: vi.fn(),
  requireHostingerApiAccess: vi.fn(),
  parseCreateDatabaseRequest: vi.fn(),
  parseDatabaseListSearchParams: vi.fn(),
  createDatabaseForSite: vi.fn(),
  listDatabasesForSite: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/security/request-origin", () => ({
  assertTrustedMutationRequest: mocks.assertTrustedMutationRequest,
}));
vi.mock("@/lib/hostinger/api-access", () => ({
  requireHostingerApiAccess: mocks.requireHostingerApiAccess,
}));
vi.mock("@/lib/hostinger/database-input", () => ({
  parseCreateDatabaseRequest: mocks.parseCreateDatabaseRequest,
  parseDatabaseListSearchParams: mocks.parseDatabaseListSearchParams,
}));
vi.mock("@/lib/hostinger/database-service", () => ({
  createDatabaseForSite: mocks.createDatabaseForSite,
  listDatabasesForSite: mocks.listDatabasesForSite,
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

import { GET, POST } from "./route";

const current = {
  user: { id: "22222222-2222-4222-8222-222222222222" },
  site: {
    siteId: "11111111-1111-4111-8111-111111111111",
    name: "Site",
    primaryDomain: "example.com",
    hostingerUsername: "u123",
    membershipRole: "MEMBER",
  },
};
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const input = {
  nameSuffix: "shop",
  userSuffix: "app",
  password: "Strong-password-123!",
  passwordConfirmation: "Strong-password-123!",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireHostingerApiAccess.mockResolvedValue(current);
  mocks.parseCreateDatabaseRequest.mockResolvedValue({
    input,
    idempotencyKey,
  });
  mocks.parseDatabaseListSearchParams.mockReturnValue({
    page: 1,
    perPage: 25,
  });
  mocks.createDatabaseForSite.mockResolvedValue({
    accepted: true,
    referenceId: "abcdef123456",
    idempotencyStatus: "created",
  });
  mocks.listDatabasesForSite.mockResolvedValue({
    databases: [],
    pagination: {
      page: 1,
      perPage: 25,
      total: 0,
      totalPages: 0,
      hasPrevious: false,
      hasNext: false,
    },
    discarded: { invalid: 0, missingDomain: 0, otherDomain: 0 },
    lastVerifiedAt: "2026-07-29T10:00:00.000Z",
  });
});

describe("/api/databases", () => {
  it("lists only through the database site capability", async () => {
    const request = new NextRequest(
      "https://console.test/api/databases?page=1&per_page=25",
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
      "database.list",
    );
    expect(mocks.listDatabasesForSite).toHaveBeenCalledWith(current, {
      page: 1,
      perPage: 25,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns the safe diagnostic reference when a database read fails", async () => {
    mocks.listDatabasesForSite.mockRejectedValueOnce(
      new AppError(
        "HOSTINGER_ERROR",
        "Hostinger rejected the configured site request.",
        422,
        "corr-private",
        "a1b2c3d4e5f6",
      ),
    );
    const response = await GET(
      new NextRequest(
        "https://console.test/api/databases?page=1&per_page=25",
      ),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "HOSTINGER_ERROR",
        message: "Hostinger rejected the configured site request.",
        referenceId: "a1b2c3d4e5f6",
      },
    });
  });

  it("checks origin before creating and passes no browser-controlled domain or account username", async () => {
    const request = createRequest();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.assertTrustedMutationRequest).toHaveBeenCalledWith(request);
    expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
      "database.create",
    );
    expect(mocks.createDatabaseForSite).toHaveBeenCalledWith(
      current,
      input,
      idempotencyKey,
    );
    expect(mocks.revalidatePath.mock.calls).toEqual([
      ["/databases"],
      ["/overview"],
    ]);
  });

  it("rejects an untrusted origin before session, parsing or mutation", async () => {
    mocks.assertTrustedMutationRequest.mockImplementation(() => {
      throw new AppError("FORBIDDEN", "Origin denied.", 403);
    });
    const response = await POST(createRequest());
    expect(response.status).toBe(403);
    expect(mocks.requireHostingerApiAccess).not.toHaveBeenCalled();
    expect(mocks.parseCreateDatabaseRequest).not.toHaveBeenCalled();
    expect(mocks.createDatabaseForSite).not.toHaveBeenCalled();
  });

  it.each([
    new AppError("NOT_FOUND", "Site not found.", 404),
    new AppError("FORBIDDEN", "Access denied.", 403),
  ])("does not mutate when access is denied", async (error) => {
    mocks.requireHostingerApiAccess.mockRejectedValue(error);
    const response = await POST(createRequest());
    expect(response.status).toBe(error.status);
    expect(mocks.createDatabaseForSite).not.toHaveBeenCalled();
  });
});

function createRequest() {
  return new NextRequest("https://console.test/api/databases", {
    method: "POST",
    headers: {
      Origin: "https://console.test",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });
}
