import { describe, expect, it } from "vitest";
import {
  decodeAliases,
  decodeDnsSnapshot,
  decodeDnsSnapshots,
  decodeDnsZone,
  decodeSubdomains,
  normalizeAliasInput,
  normalizeDnsContent,
  normalizeDnsOwnerName,
  normalizeSubdomainDirectory,
  normalizeSubdomainInput,
  parseSnapshotId,
} from "./domain-codec";
import { officialDnsRecordTypes } from "./domain-types";
import { zoneView } from "./domain-service";

describe("Hostinger domain decoders", () => {
  it("decodes every DNS type from OpenAPI 1.23.0 and excludes unknown groups", () => {
    const samples: Record<string, string> = {
      A: "192.0.2.10",
      AAAA: "2001:db8::10",
      CNAME: "target.example.net.",
      ALIAS: "target.example.net.",
      MX: "10 mail.example.net.",
      TXT: '"hello  world"',
      NS: "ns1.example.net.",
      SOA: "ns1.example.net. hostmaster.example.net. 1 3600 600 86400 300",
      SRV: "10 20 443 target.example.net.",
      CAA: '0 issue "letsencrypt.org"',
    };
    const payload = [
      ...officialDnsRecordTypes.map((type) => ({
        name: type === "SOA" || type === "NS" ? "@" : type.toLowerCase(),
        type,
        ttl: 14400,
        records: [{ content: samples[type], is_disabled: false }],
        ignored: "not returned",
      })),
      { name: "unknown", type: "HTTPS", records: [{ content: "x" }] },
    ];
    const result = decodeDnsZone(payload, "example.com");
    expect(result.groups.map((group) => group.type)).toEqual(officialDnsRecordTypes);
    expect(result.discarded).toBe(1);
    expect(result.groups.find((group) => group.type === "TXT")?.records[0].content).toBe('"hello  world"');
  });

  it("rejects malformed type-specific values without returning unknown fields", () => {
    const result = decodeDnsZone(
      [
        { name: "bad-a", type: "A", ttl: 60, records: [{ content: "999.1.1.1" }] },
        { name: "bad-mx", type: "MX", ttl: 60, records: [{ content: "mail.example.com." }] },
        { name: "good", type: "AAAA", ttl: 60, records: [{ content: "2001:db8::1", secret: "x" }] },
      ],
      "example.com",
    );
    expect(result.groups).toEqual([
      {
        name: "good",
        fqdn: "good.example.com",
        type: "AAAA",
        ttl: 60,
        records: [{ content: "2001:db8::1", isDisabled: false }],
      },
    ]);
    expect(result.discarded).toBe(4);
  });

  it("normalizes owner IDNA, apex and rooted targets without changing TXT", () => {
    expect(normalizeDnsOwnerName("@", "example.com")).toEqual({ relative: "@", fqdn: "example.com" });
    expect(normalizeDnsOwnerName("caffè", "example.com")).toEqual({ relative: "xn--caff-8oa", fqdn: "xn--caff-8oa.example.com" });
    expect(normalizeDnsContent("CNAME", "caffè.example.")).toBe("xn--caff-8oa.example.");
    expect(normalizeDnsContent("TXT", '  "a  b"  ')).toBe('  "a  b"  ');
  });

  it("marks SOA and apex NS protected and critical website/email records", () => {
    const zone = zoneView(
      decodeDnsZone(
        [
          { name: "@", type: "SOA", records: [{ content: "ns.example. host.example. 1 2 3 4 5" }] },
          { name: "@", type: "NS", records: [{ content: "ns.example." }] },
          { name: "www", type: "A", records: [{ content: "192.0.2.1" }] },
          { name: "@", type: "MX", records: [{ content: "10 mail.example." }] },
          { name: "_dmarc", type: "TXT", records: [{ content: '"v=DMARC1; p=none"' }] },
        ],
        "example.com",
      ).groups,
      "example.com",
    );
    expect(zone.records.filter((record) => record.protected).map((record) => record.type)).toEqual(["NS", "SOA"]);
    expect(zone.records.filter((record) => record.critical).map((record) => record.type).sort()).toEqual(["A", "MX", "TXT"]);
  });

  it("decodes snapshot IDs and records while validating identifiers", () => {
    expect(decodeDnsSnapshots([{ id: 12, reason: "ignored", created_at: "2026-01-01T00:00:00Z" }])).toEqual({ snapshots: [{ id: "12", createdAt: "2026-01-01T00:00:00Z" }], discarded: 0 });
    expect(decodeDnsSnapshot({ id: 12, reason: "ignored", created_at: "2026-01-01T00:00:00Z", snapshot: [{ name: "www", type: "A", records: [{ content: "192.0.2.1" }] }] }, "example.com").groups).toHaveLength(1);
    expect(parseSnapshotId("12")).toBe(12);
    expect(() => parseSnapshotId("1/restore")).toThrow();
  });

  it("accepts only exact subordinate subdomains and safe relative directories", () => {
    expect(normalizeSubdomainInput("docs", "example.com")).toEqual({ label: "docs", fqdn: "docs.example.com" });
    expect(normalizeSubdomainInput("caffè.example.com", "example.com").fqdn).toBe("xn--caff-8oa.example.com");
    for (const value of ["example.com", "*.example.com", "x.other.com", "https://x.example.com", "x.example.com/path", "../x"]) {
      expect(() => normalizeSubdomainInput(value, "example.com")).toThrow();
    }
    expect(normalizeSubdomainDirectory("apps/docs")).toBe("apps/docs");
    for (const value of ["/root", "..", "a/../b", "a\\b", "a\0b"]) {
      expect(() => normalizeSubdomainDirectory(value)).toThrow();
    }
  });

  it("filters subdomain response infrastructure fields and wrong-site records", () => {
    const result = decodeSubdomains(
      [
        { username: "u1", domain: "docs.example.com", parent_domain: "example.com", root_directory: "/secret/path", subdomain: "docs" },
        { username: "u2", domain: "other.example.com", parent_domain: "example.com", root_directory: "/secret/path", subdomain: "other" },
      ],
      "u1",
      "example.com",
    );
    expect(result).toEqual({ subdomains: [{ label: "docs", fqdn: "docs.example.com" }], discarded: 1 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("accepts public alias hostnames and rejects URL, IP, primary and local values", () => {
    expect(normalizeAliasInput("CAFFÈ.example", "example.com")).toBe("xn--caff-8oa.example");
    for (const value of ["https://alias.example", "192.0.2.1", "example.com", "localhost", "dev.local", "alias.example/path"] ) {
      expect(() => normalizeAliasInput(value, "example.com")).toThrow();
    }
    const result = decodeAliases(
      [
        { username: "u1", domain: "alias.example", parent_domain: "example.com", root_directory: "/secret", type: "domain" },
        { username: "u1", domain: "192.0.2.1", parent_domain: "example.com", root_directory: "/secret", type: "ip" },
      ],
      "u1",
      "example.com",
    );
    expect(result).toEqual({ aliases: ["alias.example"], discarded: 1 });
  });
});
