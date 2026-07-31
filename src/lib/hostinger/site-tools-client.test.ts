import { describe, expect, it, vi } from "vitest";
import {
  HostingerClient,
  validateAdvisoryLink,
  validateGithubPullRequestLink,
} from "./client";

function response(status: number, body: unknown) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "corr-site-tools",
    },
  });
}

describe("Hostinger cache and vulnerability client", () => {
  it("uses the exact cache paths, methods and enabled boolean bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response(200, { message: "accepted" }),
      );
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl,
    });

    await client.clearWebsiteCache("u123", "EXAMPLE.com.");
    await client.toggleWebsiteCache("u123", "example.com", true);
    await client.toggleWebsiteCachelessMode(
      "u123",
      "example.com",
      false,
    );

    expect(
      fetchImpl.mock.calls.map(([url, init]) => ({
        url,
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "https://developers.hostinger.com/api/hosting/v1/accounts/u123/websites/example.com/cache/clear",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://developers.hostinger.com/api/hosting/v1/accounts/u123/websites/example.com/cache/toggle",
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      },
      {
        url: "https://developers.hostinger.com/api/hosting/v1/accounts/u123/websites/example.com/cacheless-mode/toggle",
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      },
    ]);
  });

  it("normalizes only documented vulnerability fields and uses exploded severity filters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(200, [
        {
          vulnerability_id: "GHSA-1111-2222-3333",
          package_name: "@scope/package",
          installed_version: "1.2.3",
          severity: "high",
          cvss_score: 8.8,
          cve: "CVE-2026-12345",
          is_direct: false,
          is_patchable: true,
          fix_version: "1.2.4",
          is_patching_in_progress: false,
          published_at: "2026-07-30T10:00:00Z",
          url: "https://github.com/advisories/GHSA-1111-2222-3333",
          description: "must-not-escape",
          raw_private_data: "must-not-escape",
        },
      ]),
    );
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl,
    });

    const result = await client.listNodeVulnerabilities(
      "u123",
      "example.com",
      ["high", "critical"],
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u123/websites/example.com/nodejs/vulnerabilities?severities=high&severities=critical",
    );
    expect(result.vulnerabilities).toEqual([
      {
        id: "GHSA-1111-2222-3333",
        packageName: "@scope/package",
        installedVersion: "1.2.3",
        severity: "high",
        cvssScore: 8.8,
        cve: "CVE-2026-12345",
        isDirect: false,
        isPatchable: true,
        fixVersion: "1.2.4",
        isPatchingInProgress: false,
        publishedAt: "2026-07-30T10:00:00Z",
        advisoryUrl:
          "https://github.com/advisories/GHSA-1111-2222-3333",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /description|raw_private_data|must-not-escape/i,
    );
  });

  it("rejects malformed vulnerability payloads and unsafe advisory links", async () => {
    const malformed = new HostingerClient({
      token: "private-token",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(200, [
            {
              vulnerability_id: "GHSA-1111-2222-3333",
              package_name: "pkg",
              installed_version: "1.0.0",
              severity: "severe",
              is_direct: true,
              is_patchable: true,
              is_patching_in_progress: false,
            },
          ]),
        ),
    });
    await expect(
      malformed.listNodeVulnerabilities("u123", "example.com"),
    ).rejects.toMatchObject({ status: 502 });
    expect(() =>
      validateAdvisoryLink("http://github.com/advisories/GHSA-x"),
    ).toThrow();
    expect(() =>
      validateAdvisoryLink(
        "https://user:password@example.com/advisory",
      ),
    ).toThrow();
  });

  it("sends vulnerability_ids and validates the GitHub pull-request response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(201, {
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: 42,
        head_branch: "fix/patch-vulnerabilities-abcd",
        patched_vulnerability_ids: ["GHSA-1111-2222-3333"],
        raw: "must-not-escape",
      }),
    );
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl,
    });
    const result = await client.patchNodeVulnerabilities(
      "u123",
      "example.com",
      ["GHSA-1111-2222-3333"],
    );

    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        vulnerability_ids: ["GHSA-1111-2222-3333"],
      }),
    });
    expect(result).toEqual({
      accepted: true,
      patchedVulnerabilityIds: ["GHSA-1111-2222-3333"],
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      pullRequestNumber: 42,
      headBranch: "fix/patch-vulnerabilities-abcd",
      correlationId: "corr-site-tools",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("rejects non-GitHub and non-pull-request patch URLs", () => {
    expect(() =>
      validateGithubPullRequestLink(
        "https://evil.example/owner/repo/pull/42",
      ),
    ).toThrow();
    expect(() =>
      validateGithubPullRequestLink(
        "https://github.com/owner/repo/issues/42",
      ),
    ).toThrow();
  });

  it("rejects mismatched PR metadata and unsafe branch names", async () => {
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        response(201, {
          pr_url: "https://github.com/owner/repo/pull/42",
          pr_number: 43,
          head_branch: "fix/../unsafe",
          patched_vulnerability_ids: ["GHSA-1111-2222-3333"],
        }),
      ),
    });
    await expect(
      client.patchNodeVulnerabilities(
        "u123",
        "example.com",
        ["GHSA-1111-2222-3333"],
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});
