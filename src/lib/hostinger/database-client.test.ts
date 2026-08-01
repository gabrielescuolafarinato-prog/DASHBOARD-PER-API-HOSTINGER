import { describe, expect, it, vi } from "vitest";
import { HostingerClient } from "./client";
import { validateAuthenticatedPhpMyAdminLink } from "./phpmyadmin-link";
import type { AppErrorCode } from "@/lib/errors";

function response(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(
  body: unknown,
  phpMyAdminAllowedHostSuffixes?: readonly string[],
) {
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
      phpMyAdminAllowedHostSuffixes,
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
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries one filtered 422 without filters and keeps the authoritative username", async () => {
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          422,
          {
            error: "domain has a Production-specific validation issue",
            correlation_id: "corr-filtered",
          },
        ),
      )
      .mockResolvedValueOnce(
        response(
          200,
          {
            data: [
              {
                name: "u1_site",
                user: "u1_app",
                domain: "EXAMPLE.com.",
              },
              {
                name: "u1_foreign",
                user: "u1_foreign",
                domain: "other.example",
              },
              {
                name: "u1_unassigned",
                user: "u1_none",
                domain: null,
              },
            ],
            meta: { current_page: 1, per_page: 100, total: 3 },
          },
          { "x-correlation-id": "corr-fallback" },
        ),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    const result = await client.listDatabases(
      "authoritative-user",
      "example.com",
      { page: 1, perPage: 100 },
      { allowUnfilteredFallback: true },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://developers.hostinger.com/api/hosting/v1/accounts/authoritative-user/databases?page=1&per_page=100&domain=example.com&is_assigned=true",
      "https://developers.hostinger.com/api/hosting/v1/accounts/authoritative-user/databases?page=1&per_page=100",
    ]);
    expect(result.databases).toEqual([
      {
        name: "u1_site",
        user: "u1_app",
        domain: "example.com",
        diskUsageMb: undefined,
        maxSizeMb: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);
    expect(result.discarded).toEqual({
      invalid: 0,
      missingDomain: 1,
      otherDomain: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /other\.example|u1_foreign|u1_unassigned/i,
    );
    expect(consoleInfo).toHaveBeenCalledTimes(2);
    expect(consoleInfo.mock.calls[0][1]).toMatchObject({
      phase: "database_list_filtered",
      upstreamStatus: 422,
      correlationId: "corr-filtered",
      attempt: "filtered",
      result: "retry",
    });
    expect(consoleInfo.mock.calls[1][1]).toMatchObject({
      phase: "database_list_fallback",
      upstreamStatus: 200,
      correlationId: "corr-fallback",
      attempt: "fallback",
      result: "success",
      referenceId: (
        consoleInfo.mock.calls[0][1] as { referenceId: string }
      ).referenceId,
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toMatch(
      /Production-specific|private-server-token|example\.com|authoritative-user|u1_site/i,
    );
    consoleInfo.mockRestore();
  });

  it("keeps search on the single unfiltered retry when explicitly requested", async () => {
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(422, { correlation_id: "corr-filtered" }),
      )
      .mockResolvedValueOnce(
        response(200, {
          data: [],
          meta: { current_page: 3, per_page: 25, total: 0 },
        }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await client.listDatabases(
      "u1",
      "example.com",
      { page: 3, perPage: 25, search: "u1_shop" },
      { allowUnfilteredFallback: true },
    );

    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases?page=3&per_page=25&search=u1_shop",
    );
    consoleInfo.mockRestore();
  });

  it("performs the unfiltered fallback only once and returns its reference ID on failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(422, { correlation_id: "corr-filtered" }),
      )
      .mockResolvedValueOnce(
        response(422, { correlation_id: "corr-fallback" }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    let caught: unknown;
    try {
      await client.listDatabases(
        "u1",
        "example.com",
        { page: 1, perPage: 100 },
        { allowUnfilteredFallback: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(caught).toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 422,
      correlationId: "corr-fallback",
      referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(consoleError.mock.calls.at(-1)?.[1]).toMatchObject({
      phase: "database_list_fallback",
      upstreamStatus: 422,
      result: "failure",
      referenceId: (caught as { referenceId: string }).referenceId,
    });
    consoleError.mockRestore();
  });

  it.each([401, 403, 404, 429, 500])(
    "does not fallback an HTTP %i database-list failure",
    async (status) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(status, { correlation_id: "corr-no-retry" }),
        );
      const client = new HostingerClient({
        token: "private-server-token",
        fetchImpl,
      });

      await expect(
        client.listDatabases(
          "u1",
          "example.com",
          { page: 1, perPage: 100 },
          { allowUnfilteredFallback: true },
        ),
      ).rejects.toMatchObject({
        referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0][1]).toMatchObject({
        phase: "database_list_filtered",
        attempt: "filtered",
        result: "failure",
      });
      consoleError.mockRestore();
    },
  );

  it("does not fallback a timeout or a successful response that fails decoding", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const timeoutFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const timeoutClient = new HostingerClient({
      token: "private-server-token",
      fetchImpl: timeoutFetch,
      timeoutMs: 1,
    });

    await expect(
      timeoutClient.listDatabases(
        "u1",
        "example.com",
        { page: 1, perPage: 100 },
        { allowUnfilteredFallback: true },
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect(timeoutFetch).toHaveBeenCalledOnce();

    const decodeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, { data: [], meta: null }));
    const decodeClient = new HostingerClient({
      token: "private-server-token",
      fetchImpl: decodeFetch,
    });
    await expect(
      decodeClient.listDatabases(
        "u1",
        "example.com",
        { page: 1, perPage: 100 },
        { allowUnfilteredFallback: true },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(decodeFetch).toHaveBeenCalledOnce();
    expect(
      consoleError.mock.calls.filter(
        (call) =>
          (
            call[1] as {
              phase?: string;
              result?: string;
            }
          ).phase === "database_list_filtered" &&
          (call[1] as { result?: string }).result === "failure",
      ),
    ).toHaveLength(2);
    consoleError.mockRestore();
  });

  it("does not enable an account-wide fallback unless the read caller explicitly opts in", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(422, { correlation_id: "corr-no-fallback" }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await expect(
      client.listDatabases("u1", "example.com", {
        page: 1,
        perPage: 100,
        search: "u1_shop",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).toHaveBeenCalledOnce();
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
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a remote-list 422 once without domain", async () => {
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(422, {
          error: "private validation body",
          correlation_id: "corr-remote-filtered",
        }),
      )
      .mockResolvedValueOnce(
        response(
          200,
          [
            {
              database_name: "u1_shop",
              database_user: "u1_app",
              ip: "192.0.2.10",
              private: "must-not-escape",
            },
          ],
          { "x-correlation-id": "corr-remote-fallback" },
        ),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    const result = await client.listDatabaseRemoteConnections(
      "authoritative-user",
      "example.com",
    );

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://developers.hostinger.com/api/hosting/v1/accounts/authoritative-user/databases/remote-connections?domain=example.com",
      "https://developers.hostinger.com/api/hosting/v1/accounts/authoritative-user/databases/remote-connections",
    ]);
    expect(result.connections).toEqual([
      {
        databaseName: "u1_shop",
        databaseUser: "u1_app",
        ip: "192.0.2.10",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(consoleInfo.mock.calls[0][1]).toMatchObject({
      phase: "remote_list_filtered",
      result: "retry",
    });
    expect(consoleInfo.mock.calls[1][1]).toMatchObject({
      phase: "remote_list_fallback",
      result: "success",
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toMatch(
      /private validation body|authoritative-user|example\.com|u1_shop|192\.0\.2\.10/i,
    );
    consoleInfo.mockRestore();
  });

  it("keeps database-list and remote-list fallback diagnostics independent", async () => {
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(422, {}))
      .mockResolvedValueOnce(
        response(200, {
          data: [],
          meta: { current_page: 1, per_page: 100, total: 0 },
        }),
      )
      .mockResolvedValueOnce(response(422, {}))
      .mockResolvedValueOnce(response(200, []));
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await client.listDatabases(
      "u1",
      "example.com",
      { page: 1, perPage: 100 },
      { allowUnfilteredFallback: true },
    );
    await client.listDatabaseRemoteConnections("u1", "example.com");

    const diagnostics = consoleInfo.mock.calls.map(
      (call) => call[1] as { phase: string; referenceId: string },
    );
    expect(diagnostics.map((item) => item.phase)).toEqual([
      "database_list_filtered",
      "database_list_fallback",
      "remote_list_filtered",
      "remote_list_fallback",
    ]);
    expect(diagnostics[0].referenceId).toBe(diagnostics[1].referenceId);
    expect(diagnostics[2].referenceId).toBe(diagnostics[3].referenceId);
    expect(diagnostics[0].referenceId).not.toBe(diagnostics[2].referenceId);
  });

  it("returns the same safe reference when the remote fallback fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(422, { correlation_id: "corr-remote-filtered" }),
      )
      .mockResolvedValueOnce(
        response(503, { correlation_id: "corr-remote-fallback" }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    let caught: unknown;
    try {
      await client.listDatabaseRemoteConnections("u1", "example.com");
    } catch (error) {
      caught = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(caught).toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 503,
      referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(consoleError.mock.calls.at(-1)?.[1]).toMatchObject({
      phase: "remote_list_fallback",
      result: "failure",
      referenceId: (caught as { referenceId: string }).referenceId,
    });
    consoleError.mockRestore();
  });

  it("does not fallback a non-422 remote-list failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(429, { correlation_id: "corr-remote-rate" }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await expect(
      client.listDatabaseRemoteConnections("u1", "example.com"),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      phase: "remote_list_filtered",
      result: "failure",
    });
    consoleError.mockRestore();
  });

  it("accepts a temporary public HTTPS link from the authenticated endpoint", async () => {
    const { client, fetchImpl } = clientWith({
      link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
      extra: "must-not-escape",
    });
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).resolves.toEqual({
      link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
      responseShape: "direct",
      correlationId: "corr-db",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/databases/u1_shop/phpmyadmin-link",
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(() =>
      validateAuthenticatedPhpMyAdminLink(
        "http://auth-db123.hostinger.com/signon",
      ),
    ).toThrow();
    expect(() =>
      validateAuthenticatedPhpMyAdminLink(
        "https://localhost/signon",
      ),
    ).toThrow();
    expect(() =>
      validateAuthenticatedPhpMyAdminLink(
        "https://user:secret@db.hostinger.com/signon",
      ),
    ).toThrow();
    expect(
      validateAuthenticatedPhpMyAdminLink(
        "https://auth-db123.hostinger.com/signon?username=u1&password=secret",
      ),
    ).toBe(
      "https://auth-db123.hostinger.com/signon?username=u1&password=secret",
    );
  });

  it("accepts the real-host-compatible public DNS model without a suffix pin", async () => {
    const publicLink =
      "https://secure-login.infrastructure-provider.net/signon.php?signature=temporary";
    const { client } = clientWith({ link: publicLink });
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).resolves.toMatchObject({ link: publicLink, responseShape: "direct" });
  });

  it("applies an optional server-side suffix pin", async () => {
    const publicLink =
      "https://secure-login.infrastructure-provider.net/signon.php";
    const { client } = clientWith(
      { link: publicLink },
      ["approved-provider.net"],
    );
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).rejects.toMatchObject({
      failureKind: "configured_host_not_allowed",
      diagnosticCode: "PHPMYADMIN_CONFIGURED_HOST_NOT_ALLOWED",
    });
  });

  it("accepts only the bounded data wrapper for a phpMyAdmin link", async () => {
    const { client } = clientWith({
      data: {
        link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
        raw: "must-not-escape",
      },
    });

    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).resolves.toEqual({
      link: "https://auth-db123.hostinger.com/signon.php?sid=temporary",
      responseShape: "data_wrapper",
      correlationId: "corr-db",
    });
  });

  it.each([
    [
      {
        link:
          "https://auth-db123.hostinger.com/signon.php?sid=one",
        data: {
          link:
            "https://auth-db123.hostinger.com/signon.php?sid=two",
        },
      },
      "ambiguous_link",
    ],
    [{ data: {} }, "missing_link"],
    [{ link: 123 }, "response_shape"],
    [[{ link: "https://auth-db123.hostinger.com/signon" }], "response_shape"],
  ] as const)(
    "rejects a phpMyAdmin payload as %s",
    async (payload, failureKind) => {
      const { client } = clientWith(payload);
      await expect(
        client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
      ).rejects.toMatchObject({
        status: 502,
        failureKind,
      });
    },
  );

  it("preserves only the static response shape when URL validation fails", async () => {
    const { client } = clientWith({
      data: {
        link: "https://localhost/signon.php?sid=private",
      },
    });
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).rejects.toMatchObject({
      status: 502,
      failureKind: "local_hostname",
      responseShape: "data_wrapper",
    });
  });

  it("classifies a non-JSON success body as response_shape without exposing it", async () => {
    const rawBody = "temporary-link-body-must-not-escape";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(rawBody, {
          status: 200,
          headers: { "x-correlation-id": "corr-db" },
        }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).rejects.toMatchObject({
      status: 502,
      failureKind: "response_shape",
      correlationId: "corr-db",
      diagnosticCode: "PHPMYADMIN_RESPONSE_SHAPE",
      payloadStructure: {
        payloadKind: "string",
        hasDirectLink: false,
        hasData: false,
        dataKind: "other",
        hasWrappedLink: false,
        responseShape: "unknown",
      },
    });
    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).rejects.not.toThrow(rawBody);
  });

  it("classifies an empty successful body as missing_link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "x-correlation-id": "corr-db" },
        }),
      );
    const client = new HostingerClient({
      token: "private-server-token",
      fetchImpl,
    });

    await expect(
      client.getDatabasePhpMyAdminLink("u1", "u1_shop"),
    ).rejects.toMatchObject({
      status: 502,
      failureKind: "missing_link",
      diagnosticCode: "PHPMYADMIN_MISSING_LINK",
      payloadStructure: {
        payloadKind: "null",
        hasDirectLink: false,
        hasData: false,
        dataKind: "other",
        hasWrappedLink: false,
        responseShape: "unknown",
      },
    });
  });

  it.each<[number, AppErrorCode, number]>([
    [401, "HOSTINGER_ERROR", 401],
    [403, "HOSTINGER_ERROR", 403],
    [404, "NOT_FOUND", 404],
    [409, "CONFLICT", 409],
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
