import { describe, expect, it, vi } from "vitest";
import { HostingerClient } from "./client";

describe("Hostinger official domain endpoints", () => {
  it("uses the configured domain for DNS reads and forces overwrite false for validate and PUT", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(null));
    const client = new HostingerClient({ token: "test", baseUrl: "https://api.test", fetchImpl });
    await client.getDnsZone("Example.COM.");
    const group = {
      name: "www",
      fqdn: "www.example.com",
      type: "A" as const,
      ttl: 300,
      records: [{ content: "192.0.2.1", isDisabled: false }],
    };
    await client.validateDnsZoneUpdate("example.com", [group]);
    await client.updateDnsZone("example.com", [group]);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://api.test/api/dns/v1/zones/example.com", "GET"],
      ["https://api.test/api/dns/v1/zones/example.com/validate", "POST"],
      ["https://api.test/api/dns/v1/zones/example.com", "PUT"],
    ]);
    for (const index of [1, 2]) {
      expect(JSON.parse(String(fetchImpl.mock.calls[index][1]?.body))).toEqual({
        overwrite: false,
        zone: [{ name: "www", type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] }],
      });
    }
  });

  it("uses only official snapshot, subdomain and parked-domain paths", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 7, created_at: "2026-01-01T00:00:00Z", snapshot: [] }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(null));
    const client = new HostingerClient({ token: "test", baseUrl: "https://api.test", fetchImpl });
    await client.listDnsSnapshots("example.com");
    await client.getDnsSnapshot("example.com", "7");
    await client.listSubdomains("u1", "example.com");
    await client.createSubdomain("u1", "example.com", { subdomain: "docs", directory: "docs", isUsingPublicDirectory: false });
    await client.deleteSubdomain("u1", "example.com", "docs");
    await client.listDomainAliases("u1", "example.com");
    await client.createDomainAlias("u1", "example.com", "alias.example");
    await client.deleteDomainAlias("u1", "example.com", "alias.example");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.test/api/dns/v1/snapshots/example.com",
      "https://api.test/api/dns/v1/snapshots/example.com/7",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/subdomains",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/subdomains",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/subdomains/docs",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/parked-domains",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/parked-domains",
      "https://api.test/api/hosting/v1/accounts/u1/websites/example.com/parked-domains/alias.example",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({
      subdomain: "docs",
      directory: "docs",
      is_using_public_directory: false,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[6][1]?.body))).toEqual({ parked_domain: "alias.example" });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
