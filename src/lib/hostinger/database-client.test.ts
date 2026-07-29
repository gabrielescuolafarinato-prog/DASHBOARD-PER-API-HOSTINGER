import { describe, expect, it, vi } from "vitest";
import { HostingerClient, validatePhpMyAdminLink } from "./client";
import type { AppErrorCode } from "@/lib/errors";

function response(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(body: unknown) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      response(200, body, { "x-correlation-id": "corr-db" }),
    );
  return {
    fetchImpl,
    client: new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    }),
  };
}

describe("Hostinger database client", () => {
  it("always sends authoritative domain and is_assigned filters and post-filters every record", async () => {
    const { client, fetchImpl } = clientWith({
      data: [
        {
          name: "u1_site",
          user: "u1_app",
          domain: "EXAMPLE.com.",
          disk_usage_mb: 12,
          max_size_mb: 1024,
          created_at: "2024-05-29T07:49:49+02:00",
          updated_at: "2024-05-30T07:49:49+02:00",
          permissions: { Drop: 1 },
          private_host: "must-not-escape",
        },
        { name: "u1_other", user: "u1_other", domain: "other.example" },
        { name: "u1_unassigned", user: "u1_none", domain: null },
        { name: 42, user: "u1_invalid", domain: "example.com" },
      ],
      meta: { current_page: 1, per_page: 25, total: 4 },
    });

    const result = await client.listDatabases("u1", "example.com", {
      page: 1,
      perPage: 25,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases?page=1&per_page=25&domain=example.com&is_assigned=true",
    );
    expect(result.databases).toEqual([
      {
        name: "u1_site",
        user: "u1_app",
        domain: "example.com",
        diskUsageMb: 12,
        maxSizeMb: 1024,
        createdAt: "2024-05-29T07:49:49+02:00",
        updatedAt: "2024-05-30T07:49:49+02:00",
      },
    ]);
    expect(result.discarded).toEqual({
      invalid: 1,
      missingDomain: 1,
      otherDomain: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /other\.example|u1_unassigned|private_host|must-not-escape|permissions/i,
    );
  });

  it("uses the exact official create request shape without returning the password or raw payload", async () => {
    const { client, fetchImpl } = clientWith({
      message: "Request accepted",
      raw: "must-not-escape",
    });

    const result = await client.createDatabase("u1", {
        name: "u1_shop",
        user: "u1_app",
        password: "Strong-password-123!",
        websiteDomain: "EXAMPLE.com.",
      });
    expect(result).toEqual({
      accepted: true,
      correlationId: "corr-db",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases",
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        name: "u1_shop",
        user: "u1_app",
        password: "Strong-password-123!",
        website_domain: "example.com",
      }),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /password|raw|must-not-escape/i,
    );
  });

  it("uses the official specific methods and paths for password, repair, delete and remote connections", async () => {
    const { client, fetchImpl } = clientWith({
      message: "Request accepted",
    });

    await client.changeDatabasePassword(
      "u1",
      "u1_shop",
      "Strong-password-123!",
    );
    await client.repairDatabase("u1", "u1_shop");
    await client.deleteDatabase("u1", "u1_shop");
    await client.addDatabaseRemoteConnection(
      "u1",
      "u1_shop",
      "192.0.2.10",
    );
    await client.removeDatabaseRemoteConnection(
      "u1",
      "u1_shop",
      "2001:db8::1",
    );

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method]))
      .toEqual([
        [
          "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop/change-password",
          "PATCH",
        ],
        [
          "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop/repair",
          "PATCH",
        ],
        [
          "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop",
          "DELETE",
        ],
        [
          "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop/remote-connections",
          "POST",
        ],
        [
          "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop/remote-connections?ip=2001%3Adb8%3A%3A1",
          "DELETE",
        ],
      ]);
  });

  it("decodes only the documented remote connection fields", async () => {
    const { client, fetchImpl } = clientWith([
      {
        database_name: "u1_shop",
        database_user: "u1_app",
        ip: "192.0.2.10",
        raw: "must-not-escape",
      },
      { database_name: "u1_bad", ip: "192.0.2.11" },
    ]);
    const result = await client.listDatabaseRemoteConnections(
      "u1",
      "example.com",
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/remote-connections?domain=example.com",
    );
    expect(result).toEqual({
      connections: [
        {
          databaseName: "u1_shop",
          databaseUser: "u1_app",
          ip: "192.0.2.10",
        },
      ],
      discardedInvalid: 1,
      correlationId: "corr-db",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("accepts only temporary HTTPS links on an allowlisted Hostinger host", async () => {
    const { client } = clientWith({
      link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
      extra: "must-not-escape",
    });
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).resolves.toEqual({
      link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
      correlationId: "corr-db",
    });
    expect(() =>
      validatePhpMyAdminLink("http://auth-db123.hostinger.com/signon"),
    ).toThrow();
    expect(() =>
      validatePhpMyAdminLink("https://hostinger.com.evil.test/signon"),
    ).toThrow();
    expect(() =>
      validatePhpMyAdminLink("https://user:secret@db.hostinger.com/signon"),
    ).toThrow();
  });

  it.each<[number, AppErrorCode, number]>([
    [401, "HOSTINGER_ERROR", 401],
    [403, "HOSTINGER_ERROR", 403],
    [404, "NOT_FOUND", 404],
    [422, "HOSTINGER_ERROR", 422],
    [429, "RATE_LIMITED", 429],
    [500, "HOSTINGER_ERROR", 503],
  ])("maps database HTTP %i safely", async (status, code, mappedStatus) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(status, {
          error: "private raw Hostinger error",
          correlation_id: "corr-db",
        }),
      );
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl,
    });
    await expect(
      client.listDatabases("u1", "example.com", {
        page: 1,
        perPage: 25,
      }),
    ).rejects.toMatchObject({
      code,
      status: mappedStatus,
      correlationId: "corr-db",
    });
    await expect(
      client.listDatabases("u1", "example.com", {
        page: 1,
        perPage: 25,
      }),
    ).rejects.not.toThrow(/private raw Hostinger error|private-token/);
  });

  it("maps a database timeout without exposing request data", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = new HostingerClient({
      token: "private-token",
      fetchImpl,
      timeoutMs: 1,
    });
    await expect(
      client.createDatabase("u1", {
        name: "u1_shop",
        user: "u1_app",
        password: "Strong-password-123!",
        websiteDomain: "example.com",
      }),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 504,
    });
  });
});
