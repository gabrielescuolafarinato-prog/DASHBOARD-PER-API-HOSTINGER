import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  assertTrustedMutationRequest: vi.fn(),
  requireHostingerApiAccess: vi.fn(),
  parseCacheClearRequest: vi.fn(),
  parseCacheToggleRequest: vi.fn(),
  clearCacheForSite: vi.fn(),
  toggleCacheForSite: vi.fn(),
  toggleCachelessModeForSite: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/security/request-origin", () => ({
  assertTrustedMutationRequest: mocks.assertTrustedMutationRequest,
}));
vi.mock("@/lib/hostinger/api-access", () => ({
  requireHostingerApiAccess: mocks.requireHostingerApiAccess,
}));
vi.mock("@/lib/hostinger/cache-input", () => ({
  parseCacheClearRequest: mocks.parseCacheClearRequest,
  parseCacheToggleRequest: mocks.parseCacheToggleRequest,
}));
vi.mock("@/lib/hostinger/cache-service", () => ({
  clearCacheForSite: mocks.clearCacheForSite,
  toggleCacheForSite: mocks.toggleCacheForSite,
  toggleCachelessModeForSite: mocks.toggleCachelessModeForSite,
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

import { DELETE as clearCache } from "./clear/route";
import { PATCH as toggleCache } from "./toggle/route";
import { PATCH as toggleCacheless } from "../cacheless/toggle/route";

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
const key = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireHostingerApiAccess.mockResolvedValue(current);
  mocks.parseCacheClearRequest.mockResolvedValue({
    input: { confirmed: true },
    idempotencyKey: key,
  });
  mocks.parseCacheToggleRequest.mockResolvedValue({
    input: { enabled: true, confirmed: true },
    idempotencyKey: key,
  });
  const result = {
    accepted: true,
    referenceId: "abcdef123456",
    idempotencyStatus: "created",
  };
  mocks.clearCacheForSite.mockResolvedValue(result);
  mocks.toggleCacheForSite.mockResolvedValue(result);
  mocks.toggleCachelessModeForSite.mockResolvedValue(result);
});

describe("cache API mutation routes", () => {
  it("routes clear, cache toggle and cacheless toggle through specific capabilities", async () => {
    const clearRequest = request("/api/cache/clear", "DELETE");
    const toggleRequest = request("/api/cache/toggle", "PATCH");
    const cachelessRequest = request(
      "/api/cacheless/toggle",
      "PATCH",
    );
    expect((await clearCache(clearRequest)).status).toBe(200);
    expect((await toggleCache(toggleRequest)).status).toBe(200);
    expect((await toggleCacheless(cachelessRequest)).status).toBe(200);
    expect(
      mocks.requireHostingerApiAccess.mock.calls.map(([capability]) => capability),
    ).toEqual([
      "site.cache.clear",
      "site.cache.toggle",
      "site.cacheless.toggle",
    ]);
    expect(mocks.clearCacheForSite).toHaveBeenCalledWith(
      current,
      key,
    );
    expect(mocks.toggleCacheForSite).toHaveBeenCalledWith(
      current,
      true,
      key,
    );
    expect(mocks.toggleCachelessModeForSite).toHaveBeenCalledWith(
      current,
      true,
      key,
    );
  });

  it("blocks CSRF before access, input parsing or mutation", async () => {
    mocks.assertTrustedMutationRequest.mockImplementation(() => {
      throw new AppError("FORBIDDEN", "Origin denied.", 403);
    });
    const response = await toggleCache(
      request("/api/cache/toggle", "PATCH"),
    );
    expect(response.status).toBe(403);
    expect(mocks.requireHostingerApiAccess).not.toHaveBeenCalled();
    expect(mocks.parseCacheToggleRequest).not.toHaveBeenCalled();
    expect(mocks.toggleCacheForSite).not.toHaveBeenCalled();
  });
});

function request(path: string, method: string) {
  return new NextRequest(`https://console.test${path}`, {
    method,
    headers: {
      Origin: "https://console.test",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ enabled: true, confirmed: true }),
  });
}
