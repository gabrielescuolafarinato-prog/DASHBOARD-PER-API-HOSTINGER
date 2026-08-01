import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  assertTrustedMutationRequest: vi.fn(),
  requireHostingerApiAccess: vi.fn(),
  parseEmptyDomainSearchParams: vi.fn(),
  parseDnsCreateRequest: vi.fn(),
  parseDnsUpdateRequest: vi.fn(),
  parseDnsDeleteRequest: vi.fn(),
  parseSubdomainCreateRequest: vi.fn(),
  parseSubdomainDeleteRequest: vi.fn(),
  parseAliasCreateRequest: vi.fn(),
  parseAliasDeleteRequest: vi.fn(),
  listDnsRecordsForSite: vi.fn(),
  createDnsRecordForSite: vi.fn(),
  updateDnsRecordForSite: vi.fn(),
  deleteDnsRecordForSite: vi.fn(),
  listDnsSnapshotsForSite: vi.fn(),
  getDnsSnapshotForSite: vi.fn(),
  listSubdomainsForSite: vi.fn(),
  createSubdomainForSite: vi.fn(),
  deleteSubdomainForSite: vi.fn(),
  listAliasesForSite: vi.fn(),
  createAliasForSite: vi.fn(),
  deleteAliasForSite: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/security/request-origin", () => ({ assertTrustedMutationRequest: mocks.assertTrustedMutationRequest }));
vi.mock("@/lib/hostinger/api-access", () => ({ requireHostingerApiAccess: mocks.requireHostingerApiAccess }));
vi.mock("@/lib/hostinger/domain-input", () => ({
  parseEmptyDomainSearchParams: mocks.parseEmptyDomainSearchParams,
  parseDnsCreateRequest: mocks.parseDnsCreateRequest,
  parseDnsUpdateRequest: mocks.parseDnsUpdateRequest,
  parseDnsDeleteRequest: mocks.parseDnsDeleteRequest,
  parseSubdomainCreateRequest: mocks.parseSubdomainCreateRequest,
  parseSubdomainDeleteRequest: mocks.parseSubdomainDeleteRequest,
  parseAliasCreateRequest: mocks.parseAliasCreateRequest,
  parseAliasDeleteRequest: mocks.parseAliasDeleteRequest,
}));
vi.mock("@/lib/hostinger/domain-service", () => ({
  listDnsRecordsForSite: mocks.listDnsRecordsForSite,
  createDnsRecordForSite: mocks.createDnsRecordForSite,
  updateDnsRecordForSite: mocks.updateDnsRecordForSite,
  deleteDnsRecordForSite: mocks.deleteDnsRecordForSite,
  listDnsSnapshotsForSite: mocks.listDnsSnapshotsForSite,
  getDnsSnapshotForSite: mocks.getDnsSnapshotForSite,
  listSubdomainsForSite: mocks.listSubdomainsForSite,
  createSubdomainForSite: mocks.createSubdomainForSite,
  deleteSubdomainForSite: mocks.deleteSubdomainForSite,
  listAliasesForSite: mocks.listAliasesForSite,
  createAliasForSite: mocks.createAliasForSite,
  deleteAliasForSite: mocks.deleteAliasForSite,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { GET as getDns } from "./dns/route";
import { POST as createDns, PUT as updateDns, DELETE as deleteDns } from "./dns/records/route";
import { GET as listSnapshots } from "./dns/snapshots/route";
import { GET as getSnapshot } from "./dns/snapshots/[id]/route";
import { GET as listSubdomains, POST as createSubdomain, DELETE as deleteSubdomain } from "./subdomains/route";
import { GET as listAliases, POST as createAlias, DELETE as deleteAlias } from "./aliases/route";

const current = {
  user: { id: "actor" },
  site: { siteId: "site", primaryDomain: "example.com", hostingerUsername: "u1", membershipRole: "MEMBER" },
};
const key = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireHostingerApiAccess.mockResolvedValue(current);
  const parsed = { input: {}, idempotencyKey: key };
  for (const parser of [mocks.parseDnsCreateRequest, mocks.parseDnsUpdateRequest, mocks.parseDnsDeleteRequest, mocks.parseSubdomainCreateRequest, mocks.parseSubdomainDeleteRequest, mocks.parseAliasCreateRequest, mocks.parseAliasDeleteRequest]) parser.mockResolvedValue(parsed);
  for (const service of [mocks.listDnsRecordsForSite, mocks.createDnsRecordForSite, mocks.updateDnsRecordForSite, mocks.deleteDnsRecordForSite, mocks.listDnsSnapshotsForSite, mocks.getDnsSnapshotForSite, mocks.listSubdomainsForSite, mocks.createSubdomainForSite, mocks.deleteSubdomainForSite, mocks.listAliasesForSite, mocks.createAliasForSite, mocks.deleteAliasForSite]) service.mockResolvedValue({});
});

describe("specific domain API routes", () => {
  it("routes every read through its granular capability", async () => {
    await getDns(readRequest("/api/domains/dns"));
    await listSnapshots(readRequest("/api/domains/dns/snapshots"));
    await getSnapshot(readRequest("/api/domains/dns/snapshots/7"), { params: Promise.resolve({ id: "7" }) });
    await listSubdomains(readRequest("/api/domains/subdomains"));
    await listAliases(readRequest("/api/domains/aliases"));
    expect(mocks.requireHostingerApiAccess.mock.calls.map(([capability]) => capability)).toEqual([
      "dns.records.list",
      "dns.snapshots.list",
      "dns.snapshots.view",
      "subdomains.list",
      "aliases.list",
    ]);
    expect(mocks.getDnsSnapshotForSite).toHaveBeenCalledWith(current, "7");
  });

  it("routes POST/PUT/DELETE through exact mutation capabilities", async () => {
    await createDns(mutationRequest("/api/domains/dns/records", "POST"));
    await updateDns(mutationRequest("/api/domains/dns/records", "PUT"));
    await deleteDns(mutationRequest("/api/domains/dns/records", "DELETE"));
    await createSubdomain(mutationRequest("/api/domains/subdomains", "POST"));
    await deleteSubdomain(mutationRequest("/api/domains/subdomains", "DELETE"));
    await createAlias(mutationRequest("/api/domains/aliases", "POST"));
    await deleteAlias(mutationRequest("/api/domains/aliases", "DELETE"));
    expect(mocks.requireHostingerApiAccess.mock.calls.map(([capability]) => capability)).toEqual([
      "dns.records.create",
      "dns.records.update",
      "dns.records.delete",
      "subdomains.create",
      "subdomains.delete",
      "aliases.create",
      "aliases.delete",
    ]);
  });

  it("checks CSRF before session, input and mutation", async () => {
    mocks.assertTrustedMutationRequest.mockImplementation(() => {
      throw new AppError("FORBIDDEN", "Origin denied", 403);
    });
    const response = await createAlias(mutationRequest("/api/domains/aliases", "POST"));
    expect(response.status).toBe(403);
    expect(mocks.requireHostingerApiAccess).not.toHaveBeenCalled();
    expect(mocks.parseAliasCreateRequest).not.toHaveBeenCalled();
    expect(mocks.createAliasForSite).not.toHaveBeenCalled();
  });

  it("returns all sensitive-response no-store headers", async () => {
    const response = await getDns(readRequest("/api/domains/dns"));
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

function readRequest(path: string) {
  return new NextRequest(`https://console.test${path}`);
}

function mutationRequest(path: string, method: string) {
  return new NextRequest(`https://console.test${path}`, {
    method,
    headers: {
      Origin: "https://console.test",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: "{}",
  });
}
