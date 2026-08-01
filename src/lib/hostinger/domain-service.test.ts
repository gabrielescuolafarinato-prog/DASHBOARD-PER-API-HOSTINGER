import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createAliasForSite,
  createDnsRecordForSite,
  createSubdomainForSite,
  deleteAliasForSite,
  deleteDnsRecordForSite,
  deleteSubdomainForSite,
  listAliasesForSite,
  listDnsRecordsForSite,
  listDnsSnapshotsForSite,
  getDnsSnapshotForSite,
  listSubdomainsForSite,
  updateDnsRecordForSite,
  zoneFingerprint,
  zoneView,
} from "./domain-service";
import type { DnsRecordGroup } from "./domain-types";

const current = {
  user: { id: "22222222-2222-4222-8222-222222222222" },
  site: {
    siteId: "11111111-1111-4111-8111-111111111111",
    name: "Site",
    primaryDomain: "example.com",
    hostingerUsername: "u123",
    membershipRole: "MEMBER" as const,
  },
};
const key = "33333333-3333-4333-8333-333333333333";

const client = {
  getDnsZone: vi.fn(),
  validateDnsZoneUpdate: vi.fn(),
  updateDnsZone: vi.fn(),
  deleteDnsRecordGroups: vi.fn(),
  listDnsSnapshots: vi.fn(),
  getDnsSnapshot: vi.fn(),
  listSubdomains: vi.fn(),
  createSubdomain: vi.fn(),
  deleteSubdomain: vi.fn(),
  listDomainAliases: vi.fn(),
  createDomainAlias: vi.fn(),
  deleteDomainAlias: vi.fn(),
};
const claimOperation = vi.fn();
const finishOperation = vi.fn();
const audit = vi.fn();
const dependencies = {
  client,
  claimOperation,
  finishOperation,
  audit,
  createReferenceId: () => "abcdef123456",
};

beforeEach(() => {
  for (const mock of [...Object.values(client), claimOperation, finishOperation, audit]) mock.mockReset();
  claimOperation.mockResolvedValue({
    kind: "claimed",
    operation: {
      status: "IN_PROGRESS",
      referenceId: "abcdef123456",
      createdAt: new Date(),
    },
  });
  finishOperation.mockResolvedValue(true);
  audit.mockResolvedValue(undefined);
  client.validateDnsZoneUpdate.mockResolvedValue({ accepted: true });
  client.updateDnsZone.mockResolvedValue({ accepted: true });
  client.deleteDnsRecordGroups.mockResolvedValue({ accepted: true });
  client.createSubdomain.mockResolvedValue({ accepted: true });
  client.deleteSubdomain.mockResolvedValue({ accepted: true });
  client.createDomainAlias.mockResolvedValue({ accepted: true });
  client.deleteDomainAlias.mockResolvedValue({ accepted: true });
});

describe("site-scoped DNS service", () => {
  it("reads only with the database-derived primary domain and returns a stable fingerprint", async () => {
    client.getDnsZone.mockResolvedValue(zone([]));
    const result = await listDnsRecordsForSite(current, dependencies);
    expect(client.getDnsZone).toHaveBeenCalledWith("example.com");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.domain).toBe("example.com");
  });

  it("rereads live, validates before PUT, and verifies the post-condition", async () => {
    const before = zone([]);
    const after = zone([group("www", "www.example.com", "A", "192.0.2.10", 300)]);
    client.getDnsZone.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const order: string[] = [];
    client.validateDnsZoneUpdate.mockImplementation(async () => { order.push("validate"); return { accepted: true }; });
    client.updateDnsZone.mockImplementation(async () => { order.push("put"); return { accepted: true }; });
    const result = await createDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), record: { name: "www", type: "A", content: "192.0.2.10", ttl: 300 }, confirmation: "www.example.com" },
      key,
      dependencies,
    );
    expect(order).toEqual(["validate", "put"]);
    expect(client.validateDnsZoneUpdate).toHaveBeenCalledWith("example.com", expect.any(Array));
    expect(client.updateDnsZone).toHaveBeenCalledWith("example.com", expect.any(Array));
    expect(result).toMatchObject({ accepted: true, visibleInHostinger: true, idempotencyStatus: "created" });
    expect(claimOperation).toHaveBeenCalledWith(expect.objectContaining({ resourceKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it("stops after validation 422 and never sends PUT", async () => {
    const before = zone([]);
    client.getDnsZone.mockResolvedValueOnce(before);
    client.validateDnsZoneUpdate.mockRejectedValue(new AppError("HOSTINGER_ERROR", "Rejected", 422));
    await expect(createDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), record: { name: "api", type: "A", content: "192.0.2.10", ttl: 300 } },
      key,
      dependencies,
    )).rejects.toMatchObject({ status: 422, referenceId: "abcdef123456" });
    expect(client.updateDnsZone).not.toHaveBeenCalled();
  });

  it("blocks a stale fingerprint before validation or mutation", async () => {
    client.getDnsZone.mockResolvedValueOnce(zone([group("api", "api.example.com", "A", "192.0.2.1")]));
    await expect(createDnsRecordForSite(
      current,
      { fingerprint: "0".repeat(64), record: { name: "api", type: "A", content: "192.0.2.10" } },
      key,
      dependencies,
    )).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(client.validateDnsZoneUpdate).not.toHaveBeenCalled();
    expect(client.updateDnsZone).not.toHaveBeenCalled();
  });

  it("requires strong confirmation for critical records and keeps SOA/apex NS read-only", async () => {
    const before = zone([]);
    await expect(createDnsRecordForSite(current, { fingerprint: zoneFingerprint([]), record: { name: "www", type: "A", content: "192.0.2.1" } }, key, dependencies)).rejects.toMatchObject({ status: 400 });
    await expect(createDnsRecordForSite(current, { fingerprint: zoneFingerprint([]), record: { name: "@", type: "SOA", content: "ns.example. host.example. 1 2 3 4 5" } }, key, dependencies)).rejects.toMatchObject({ status: 403 });
    expect(client.getDnsZone).not.toHaveBeenCalled();
    expect(before.groups).toEqual([]);
  });

  it("updates only a live group's TTL and preserves all sibling values", async () => {
    const original = {
      name: "api",
      fqdn: "api.example.com",
      type: "A" as const,
      ttl: 300,
      records: [
        { content: "192.0.2.1", isDisabled: false },
        { content: "192.0.2.2", isDisabled: false },
      ],
    };
    const before = zone([original]);
    const after = zone([{ ...original, ttl: 600 }]);
    const record = zoneView(before.groups, "example.com").records[0];
    client.getDnsZone.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await updateDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), recordId: record.id, record: { name: record.name, type: record.type, content: record.content, ttl: 600 } },
      key,
      dependencies,
    );
    expect(client.updateDnsZone).toHaveBeenCalledWith(
      "example.com",
      [expect.objectContaining({ ttl: 600, records: original.records })],
    );
  });

  it("fails closed instead of pretending overwrite false can replace content", async () => {
    const before = zone([group("api", "api.example.com", "A", "192.0.2.1", 300)]);
    const record = zoneView(before.groups, "example.com").records[0];
    client.getDnsZone.mockResolvedValueOnce(before);
    await expect(updateDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), recordId: record.id, record: { name: record.name, type: record.type, content: "192.0.2.2", ttl: 300 } },
      key,
      dependencies,
    )).rejects.toMatchObject({ status: 422 });
    expect(client.validateDnsZoneUpdate).not.toHaveBeenCalled();
  });

  it("deletes a complete name/type group only after explicit group confirmation", async () => {
    const before = zone([group("api", "api.example.com", "A", "192.0.2.1")]);
    const record = zoneView(before.groups, "example.com").records[0];
    client.getDnsZone.mockResolvedValueOnce(before).mockResolvedValueOnce(zone([]));
    await deleteDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), groupId: record.groupId, mode: "group", confirmation: "DELETE api.example.com A" },
      key,
      dependencies,
    );
    expect(client.deleteDnsRecordGroups).toHaveBeenCalledWith("example.com", [{ name: "api", type: "A" }]);
  });

  it("never uses DELETE to remove only one of multiple sibling values", async () => {
    const multiple: DnsRecordGroup = {
      name: "api",
      fqdn: "api.example.com",
      type: "A",
      ttl: 300,
      records: [{ content: "192.0.2.1", isDisabled: false }, { content: "192.0.2.2", isDisabled: false }],
    };
    const before = zone([multiple]);
    const record = zoneView(before.groups, "example.com").records[0];
    client.getDnsZone.mockResolvedValueOnce(before);
    await expect(deleteDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint(before.groups), groupId: record.groupId, recordId: record.id, mode: "record", confirmation: record.name },
      key,
      dependencies,
    )).rejects.toMatchObject({ status: 409 });
    expect(client.deleteDnsRecordGroups).not.toHaveBeenCalled();
    expect(client.updateDnsZone).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous PUT and reconciles read-only when the post-condition exists", async () => {
    const before = zone([]);
    const after = zone([group("api", "api.example.com", "A", "192.0.2.1")]);
    client.getDnsZone.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    client.updateDnsZone.mockRejectedValue(new AppError("HOSTINGER_ERROR", "timeout", 504));
    const result = await createDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint([]), record: { name: "api", type: "A", content: "192.0.2.1" } },
      key,
      dependencies,
    );
    expect(result.accepted).toBe(true);
    expect(client.updateDnsZone).toHaveBeenCalledTimes(1);
  });

  it("replays a succeeded idempotency claim without a live call", async () => {
    claimOperation.mockResolvedValue({ kind: "duplicate", operation: { status: "SUCCEEDED", referenceId: "abcdef123456", createdAt: new Date() } });
    const result = await createDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint([]), record: { name: "api", type: "A", content: "192.0.2.1" } },
      key,
      dependencies,
    );
    expect(result.idempotencyStatus).toBe("replayed");
    expect(client.getDnsZone).not.toHaveBeenCalled();
  });

  it("blocks a concurrent DNS-zone mutation before any Hostinger call", async () => {
    claimOperation.mockResolvedValue({
      kind: "blocked",
      reason: "in_progress",
      operation: { status: "IN_PROGRESS", referenceId: "fedcba654321", createdAt: new Date() },
    });
    await expect(createDnsRecordForSite(
      current,
      { fingerprint: zoneFingerprint([]), record: { name: "api", type: "A", content: "192.0.2.1" } },
      key,
      dependencies,
    )).rejects.toMatchObject({ status: 409, referenceId: "fedcba654321" });
    expect(client.getDnsZone).not.toHaveBeenCalled();
    expect(client.updateDnsZone).not.toHaveBeenCalled();
  });

  it("lists and views snapshots for only the DB-derived domain without restore/reset behavior", async () => {
    client.listDnsSnapshots.mockResolvedValue({
      snapshots: [{ id: "7", createdAt: "2026-01-01T00:00:00Z" }],
      discarded: 0,
    });
    expect(await listDnsSnapshotsForSite(current, dependencies)).toEqual({
      snapshots: [{ id: "7", createdAt: "2026-01-01T00:00:00Z" }],
      discarded: 0,
    });
    const snapshotGroup = group("api", "api.example.com", "A", "192.0.2.1");
    client.getDnsSnapshot.mockResolvedValue({
      id: "7",
      createdAt: "2026-01-01T00:00:00Z",
      groups: [snapshotGroup],
      discarded: 0,
    });
    client.getDnsZone.mockResolvedValue(zone([snapshotGroup]));
    const detail = await getDnsSnapshotForSite(current, "7", dependencies);
    expect(client.listDnsSnapshots).toHaveBeenCalledWith("example.com");
    expect(client.getDnsSnapshot).toHaveBeenCalledWith("example.com", "7");
    expect(detail).toMatchObject({
      id: "7",
      comparison: { added: 0, removed: 0, unchanged: 1 },
    });
    expect(client).not.toHaveProperty("restoreDnsSnapshot");
    expect(client).not.toHaveProperty("resetDnsZone");
  });
});

describe("site-scoped subdomains and aliases", () => {
  it("creates a subordinate hostname with DB-derived username/domain and verifies it live", async () => {
    client.listSubdomains
      .mockResolvedValueOnce({ subdomains: [], discarded: 0 })
      .mockResolvedValueOnce({ subdomains: [{ fqdn: "docs.example.com", label: "docs" }], discarded: 0 });
    await createSubdomainForSite(current, { subdomain: "docs", directory: "apps/docs" }, key, dependencies);
    expect(client.createSubdomain).toHaveBeenCalledWith("u123", "example.com", {
      subdomain: "docs",
      directory: "apps/docs",
      isUsingPublicDirectory: undefined,
    });
  });

  it("rejects a live duplicate subdomain before POST", async () => {
    client.listSubdomains.mockResolvedValueOnce({
      subdomains: [{ fqdn: "docs.example.com", label: "docs" }],
      discarded: 0,
    });
    await expect(
      createSubdomainForSite(current, { subdomain: "docs" }, key, dependencies),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.createSubdomain).not.toHaveBeenCalled();
  });

  it("rejects root, wildcard, other-domain and traversal before Hostinger", async () => {
    for (const input of [
      { subdomain: "example.com" },
      { subdomain: "*.example.com" },
      { subdomain: "docs.other.com" },
      { subdomain: "docs", directory: "../outside" },
    ]) {
      await expect(createSubdomainForSite(current, input, key, dependencies)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(client.createSubdomain).not.toHaveBeenCalled();
  });

  it("deletes only a live opaque subdomain with exact confirmation and verifies absence", async () => {
    const item = { fqdn: "docs.example.com", label: "docs" };
    client.listSubdomains.mockResolvedValueOnce({ subdomains: [item], discarded: 0 });
    const listed = await listSubdomainsForSite(current, dependencies);
    client.listSubdomains
      .mockResolvedValueOnce({ subdomains: [item], discarded: 0 })
      .mockResolvedValueOnce({ subdomains: [], discarded: 0 });
    await deleteSubdomainForSite(current, { resourceId: listed.subdomains[0].id, confirmation: item.fqdn }, key, dependencies);
    expect(client.deleteSubdomain).toHaveBeenCalledWith("u123", "example.com", "docs");
  });

  it("uses the same resource lock for create and delete of one normalized subdomain", async () => {
    const item = { fqdn: "lock.example.com", label: "lock" };
    client.listSubdomains
      .mockResolvedValueOnce({ subdomains: [], discarded: 0 })
      .mockResolvedValueOnce({ subdomains: [item], discarded: 0 });
    await createSubdomainForSite(current, { subdomain: "lock" }, key, dependencies);
    const createLock = claimOperation.mock.calls.at(-1)?.[0].resourceKeyHash;
    client.listSubdomains.mockResolvedValueOnce({ subdomains: [item], discarded: 0 });
    const listed = await listSubdomainsForSite(current, dependencies);
    client.listSubdomains
      .mockResolvedValueOnce({ subdomains: [item], discarded: 0 })
      .mockResolvedValueOnce({ subdomains: [], discarded: 0 });
    await deleteSubdomainForSite(
      current,
      { resourceId: listed.subdomains[0].id, confirmation: item.fqdn },
      "44444444-4444-4444-8444-444444444444",
      dependencies,
    );
    expect(claimOperation.mock.calls.at(-1)?.[0].resourceKeyHash).toBe(createLock);
  });

  it("normalizes IDNA aliases, rejects duplicates, and controls ownership 422", async () => {
    client.listDomainAliases.mockResolvedValueOnce({ aliases: [], discarded: 0 });
    client.createDomainAlias.mockRejectedValueOnce(new AppError("HOSTINGER_ERROR", "rejected", 422));
    await expect(createAliasForSite(current, { alias: "caffè.example" }, key, dependencies)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("ownership") });
    expect(client.createDomainAlias).toHaveBeenCalledWith("u123", "example.com", "xn--caff-8oa.example");

    client.listDomainAliases.mockResolvedValueOnce({ aliases: ["alias.example"], discarded: 0 });
    await expect(createAliasForSite(current, { alias: "alias.example" }, key, dependencies)).rejects.toMatchObject({ status: 409 });
  });

  it("deletes aliases only when the opaque ID is live and confirmation is exact", async () => {
    client.listDomainAliases.mockResolvedValueOnce({ aliases: ["alias.example"], discarded: 0 });
    const listed = await listAliasesForSite(current, dependencies);
    client.listDomainAliases
      .mockResolvedValueOnce({ aliases: ["alias.example"], discarded: 0 })
      .mockResolvedValueOnce({ aliases: [], discarded: 0 });
    await deleteAliasForSite(current, { resourceId: listed.aliases[0].id, confirmation: "alias.example" }, key, dependencies);
    expect(client.deleteDomainAlias).toHaveBeenCalledWith("u123", "example.com", "alias.example");
  });

  it("keeps DNS values, aliases and subdomains out of audit metadata", async () => {
    client.listDomainAliases.mockResolvedValueOnce({ aliases: [], discarded: 0 }).mockResolvedValueOnce({ aliases: ["secret-alias.example"], discarded: 0 });
    await createAliasForSite(current, { alias: "secret-alias.example" }, key, dependencies);
    const metadata = audit.mock.calls.map(([event]) => JSON.stringify(event.metadata)).join(" ");
    expect(metadata).not.toContain("secret-alias.example");
    expect(metadata).not.toContain("u123");
    expect(metadata).not.toContain("example.com");
  });
});

function group(
  name: string,
  fqdn: string,
  type: "A" | "TXT",
  content: string,
  ttl = 300,
): DnsRecordGroup {
  return { name, fqdn, type, ttl, records: [{ content, isDisabled: false }] };
}

function zone(groups: DnsRecordGroup[]) {
  return { groups, discarded: 0 };
}
