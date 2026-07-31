import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  assertTrustedMutationRequest: vi.fn(),
  requireHostingerApiAccess: vi.fn(),
  parseVulnerabilityListSearchParams: vi.fn(),
  parseVulnerabilityPatchRequest: vi.fn(),
  listVulnerabilitiesForSite: vi.fn(),
  patchVulnerabilitiesForSite: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/security/request-origin", () => ({
  assertTrustedMutationRequest: mocks.assertTrustedMutationRequest,
}));
vi.mock("@/lib/hostinger/api-access", () => ({
  requireHostingerApiAccess: mocks.requireHostingerApiAccess,
}));
vi.mock("@/lib/hostinger/vulnerability-input", () => ({
  parseVulnerabilityListSearchParams:
    mocks.parseVulnerabilityListSearchParams,
  parseVulnerabilityPatchRequest:
    mocks.parseVulnerabilityPatchRequest,
}));
vi.mock("@/lib/hostinger/vulnerability-service", () => ({
  listVulnerabilitiesForSite: mocks.listVulnerabilitiesForSite,
  patchVulnerabilitiesForSite: mocks.patchVulnerabilitiesForSite,
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
    membershipRole: "ADMIN",
  },
};
const key = "33333333-3333-4333-8333-333333333333";
const ids = ["GHSA-1111-2222-3333"];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireHostingerApiAccess.mockResolvedValue(current);
  mocks.parseVulnerabilityListSearchParams.mockReturnValue(["high"]);
  mocks.parseVulnerabilityPatchRequest.mockResolvedValue({
    input: { vulnerabilityIds: ids, confirmed: true },
    idempotencyKey: key,
  });
  mocks.listVulnerabilitiesForSite.mockResolvedValue({
    vulnerabilities: [],
    referenceId: "abcdef123456",
  });
  mocks.patchVulnerabilitiesForSite.mockResolvedValue({
    accepted: true,
    referenceId: "abcdef123456",
    idempotencyStatus: "created",
    patchedVulnerabilityIds: ids,
  });
});

describe("/api/vulnerabilities", () => {
  it("lists through the list capability with validated severity filters", async () => {
    const request = new NextRequest(
      "https://console.test/api/vulnerabilities?severity=high",
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
      "site.vulnerabilities.list",
    );
    expect(mocks.listVulnerabilitiesForSite).toHaveBeenCalledWith(
      current,
      ["high"],
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("checks origin before patch access, parsing and mutation", async () => {
    const request = patchRequest();
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocks.assertTrustedMutationRequest).toHaveBeenCalledWith(
      request,
    );
    expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
      "site.vulnerabilities.patch",
    );
    expect(mocks.patchVulnerabilitiesForSite).toHaveBeenCalledWith(
      current,
      ids,
      key,
    );
  });

  it("rejects CSRF before any patch authority is resolved", async () => {
    mocks.assertTrustedMutationRequest.mockImplementation(() => {
      throw new AppError("FORBIDDEN", "Origin denied.", 403);
    });
    const response = await POST(patchRequest());
    expect(response.status).toBe(403);
    expect(mocks.requireHostingerApiAccess).not.toHaveBeenCalled();
    expect(mocks.parseVulnerabilityPatchRequest).not.toHaveBeenCalled();
    expect(mocks.patchVulnerabilitiesForSite).not.toHaveBeenCalled();
  });
});

function patchRequest() {
  return new NextRequest(
    "https://console.test/api/vulnerabilities",
    {
      method: "POST",
      headers: {
        Origin: "https://console.test",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        vulnerabilityIds: ids,
        confirmed: true,
      }),
    },
  );
}
