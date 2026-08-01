import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  parseAliasCreateRequest,
  parseDnsCreateRequest,
  parseDnsDeleteRequest,
  parseEmptyDomainSearchParams,
  parseSubdomainCreateRequest,
} from "./domain-input";

const key = "33333333-3333-4333-8333-333333333333";
const fingerprint = "a".repeat(64);

describe("domain API input boundary", () => {
  it("accepts the minimal DNS record body and preserves TXT exactly", async () => {
    const value = '  "hello  world"  ';
    const parsed = await parseDnsCreateRequest(request("/api/domains/dns/records", "POST", {
      fingerprint,
      record: { name: "txt", type: "TXT", content: value, ttl: 300 },
    }));
    expect(parsed.input.record.content).toBe(value);
    expect(parsed.idempotencyKey).toBe(key);
  });

  it.each(["domain", "username", "token", "overwrite", "zone", "payload"])(
    "rejects browser-controlled Hostinger field %s",
    async (field) => {
      await expect(parseDnsCreateRequest(request("/api/domains/dns/records", "POST", {
        fingerprint,
        record: { name: "api", type: "A", content: "192.0.2.1" },
        [field]: field === "overwrite" ? true : "attacker.example",
      }))).rejects.toBeDefined();
    },
  );

  it("requires record ID for a single-value delete", async () => {
    await expect(parseDnsDeleteRequest(request("/api/domains/dns/records", "DELETE", {
      fingerprint,
      groupId: "b".repeat(32),
      mode: "record",
      confirmation: "api.example.com",
    }))).rejects.toBeDefined();
  });

  it("rejects URL-like aliases and traversal-shaped extra fields at the strict parser boundary", async () => {
    const alias = await parseAliasCreateRequest(request("/api/domains/aliases", "POST", { alias: "https://alias.example" }));
    expect(alias.input.alias).toBe("https://alias.example");
    await expect(parseSubdomainCreateRequest(request("/api/domains/subdomains", "POST", {
      subdomain: "docs",
      directory: "../outside",
      domain: "other.example",
    }))).rejects.toBeDefined();
  });

  it("rejects query parameters, wrong content type and missing idempotency key", async () => {
    expect(() => parseEmptyDomainSearchParams(new URLSearchParams("domain=other.example"))).toThrow();
    await expect(parseAliasCreateRequest(new NextRequest("https://console.test/api/domains/aliases", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": key },
      body: JSON.stringify({ alias: "alias.example" }),
    }))).rejects.toBeDefined();
    await expect(parseAliasCreateRequest(new NextRequest("https://console.test/api/domains/aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "alias.example" }),
    }))).rejects.toMatchObject({ status: 400 });
  });
});

function request(path: string, method: string, body: unknown) {
  return new NextRequest(`https://console.test${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
