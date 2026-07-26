import { describe, expect, it, vi } from "vitest";
import { HostingerClient } from "./client";
import type { AppErrorCode } from "@/lib/errors";

function response(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(body: unknown) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response(200, body, { "x-correlation-id": "corr-1" }));
  return {
    fetchImpl,
    client: new HostingerClient({
      token: "server-token-value",
      fetchImpl,
    }),
  };
}

describe("Hostinger client", () => {
  it.each<[number, AppErrorCode, number]>([
    [401, "HOSTINGER_ERROR", 401],
    [403, "HOSTINGER_ERROR", 403],
    [404, "NOT_FOUND", 404],
    [422, "HOSTINGER_ERROR", 422],
    [429, "RATE_LIMITED", 429],
    [500, "HOSTINGER_ERROR", 503],
  ])(
    "maps HTTP %i to a controlled application error",
    async (status, code, mappedStatus) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(status, {
            error: "body must not be exposed",
            correlation_id: "corr-1",
          }),
        );
      const client = new HostingerClient({
        token: "do-not-leak",
        fetchImpl,
      });
      await expect(
        client.listWebsitesForConfiguredSite("example.com", "u1"),
      ).rejects.toEqual(
        expect.objectContaining({
          code,
          status: mappedStatus,
          correlationId: "corr-1",
        }),
      );
      await expect(
        client.listWebsitesForConfiguredSite("example.com", "u1"),
      ).rejects.not.toThrow(/body must not be exposed|do-not-leak/);
    },
  );

  it("post-filters exact domain and exact username and returns no other sites", async () => {
    const { client, fetchImpl } = clientWith({
      data: [
        { domain: "example.com", username: "u1", order_id: "order-1" },
        { domain: "other-customer.com", username: "u1", order_id: "order-2" },
        {
          domain: "example.com.evil.test",
          username: "u1",
          order_id: "order-3",
        },
        { domain: "example.com", username: "other-user", order_id: "order-4" },
      ],
    });

    const result = await client.listWebsitesForConfiguredSite(
      "EXAMPLE.com.",
      "u1",
    );

    expect(result.matches).toEqual([
      { domain: "example.com", username: "u1", orderId: "order-1" },
    ]);
    expect(JSON.stringify(result)).not.toContain("other-customer.com");
    expect(JSON.stringify(result)).not.toContain("example.com.evil.test");
    expect(JSON.stringify(result)).not.toContain("other-user");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/websites?domain=example.com&username=u1",
    );
  });

  it("keeps multiple exact records so the service can fail closed", async () => {
    const { client } = clientWith({
      data: [
        { domain: "example.com", username: "u1" },
        { primary_domain: "EXAMPLE.COM.", hostinger_username: "u1" },
      ],
    });
    const result = await client.listWebsitesForConfiguredSite(
      "example.com",
      "u1",
    );
    expect(result.matches).toHaveLength(2);
  });

  it.each([
    null,
    {},
    { data: {} },
    { data: [null] },
    { data: [{ domain: "example.com" }] },
    { data: [{ domain: "https://example.com", username: "u1" }] },
  ])("rejects a malformed website response", async (body) => {
    const { client } = clientWith(body);
    await expect(
      client.listWebsitesForConfiguredSite("example.com", "u1"),
    ).rejects.toMatchObject({ code: "HOSTINGER_ERROR" });
  });

  it("accepts an empty Node.js build list as a successful capability probe", async () => {
    const { client, fetchImpl } = clientWith({ data: [] });
    await expect(
      client.verifyConfiguredNodeSite("u1", "example.com"),
    ).resolves.toEqual({
      nodeEnabled: true,
      buildCount: 0,
      correlationId: "corr-1",
    });
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "/api/hosting/v1/accounts/u1/websites/example.com/nodejs/builds",
    );
  });

  it("accepts a non-empty Node.js build list without returning builds", async () => {
    const { client } = clientWith({
      data: [{ uuid: "build-one" }, { uuid: "build-two" }],
    });
    const result = await client.verifyConfiguredNodeSite("u1", "example.com");
    expect(result).toEqual({
      nodeEnabled: true,
      buildCount: 2,
      correlationId: "corr-1",
    });
    expect(JSON.stringify(result)).not.toContain("build-one");
  });

  it("rejects a malformed Node.js build response", async () => {
    const { client } = clientWith({ data: { uuid: "not-an-array" } });
    await expect(
      client.verifyConfiguredNodeSite("u1", "example.com"),
    ).rejects.toMatchObject({ code: "HOSTINGER_ERROR" });
  });

  it("validates and normalizes the official data and meta response shape", async () => {
    const buildUuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";
    const { client, fetchImpl } = clientWith({
      data: [
        {
          uuid: buildUuid,
          state: "running",
          options: {
            source_type: "archive",
            archive_path: "/private/archive.zip",
            build_script: "secret-command",
          },
          created_at: "2024-05-29T05:49:49.067239Z",
          updated_at: "2024-05-29T05:50:49.067239Z",
          raw_private_field: "must-not-reach-browser",
        },
      ],
      meta: { current_page: 2, per_page: 25, total: 76 },
    });

    const result = await client.listNodeBuilds("u1", "example.com", {
      page: 2,
      perPage: 25,
    });

    expect(result).toEqual({
      builds: [
        {
          uuid: buildUuid,
          state: "running",
          origin: "archive",
          createdAt: "2024-05-29T05:49:49.067239Z",
          updatedAt: "2024-05-29T05:50:49.067239Z",
        },
      ],
      pagination: {
        page: 2,
        perPage: 25,
        total: 76,
        totalPages: 4,
        hasPrevious: true,
        hasNext: true,
      },
      correlationId: "corr-1",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://developers.hostinger.com/api/hosting/v1/accounts/u1/websites/example.com/nodejs/builds?page=2&per_page=25",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /raw_private_field|archive_path|secret-command/,
    );
  });

  it.each([
    {
      name: "GitHub source",
      options: { source_type: "github", repository: "must-not-escape" },
      expectedOrigin: "github",
    },
    {
      name: "future source",
      options: { source_type: "gitlab-future", private: "must-not-escape" },
      expectedOrigin: "other",
    },
    {
      name: "null options",
      options: null,
      expectedOrigin: undefined,
    },
    {
      name: "unsafe source metadata",
      options: {
        source_type: "private source value that is much too long to expose",
      },
      expectedOrigin: undefined,
    },
  ])("normalizes $name without exposing options", async ({
    options,
    expectedOrigin,
  }) => {
    const { client } = clientWith({
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "completed",
          options,
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 1 },
    });

    const result = await client.listNodeBuilds("u1", "example.com", {
      page: 1,
      perPage: 25,
    });

    expect(result.builds[0].origin).toBe(expectedOrigin);
    expect(JSON.stringify(result)).not.toMatch(
      /repository|private|must-not-escape|gitlab-future/,
    );
  });

  it("accepts absent options, nullable timestamps and extra fields", async () => {
    const { client } = clientWith({
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "pending",
          created_at: null,
          updated_at: null,
          future_field: { nested: "must-not-escape" },
        },
      ],
      meta: {
        current_page: 1,
        per_page: 25,
        total: 1,
        future_meta: "must-not-escape",
      },
      future_top_level: "must-not-escape",
    });

    const result = await client.listNodeBuilds("u1", "example.com", {
      page: 1,
      perPage: 25,
    });

    expect(result.builds).toEqual([
      {
        uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
        state: "pending",
        origin: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /future_field|future_meta|future_top_level|must-not-escape/,
    );
  });

  it("preserves valid timestamps and omits invalid optional timestamps", async () => {
    const { client } = clientWith({
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "running",
          created_at: "2024-05-29T05:49:49.067239Z",
          updated_at: "not-a-timestamp",
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 1 },
    });

    const result = await client.listNodeBuilds("u1", "example.com", {
      page: 1,
      perPage: 25,
    });

    expect(result.builds[0]).toMatchObject({
      createdAt: "2024-05-29T05:49:49.067239Z",
      updatedAt: undefined,
    });
    expect(result.builds[0].updatedAt).not.toBe("Invalid Date");
  });

  it("accepts strictly numeric pagination strings within bounds", async () => {
    const { client } = clientWith({
      data: [],
      meta: { current_page: "0002", per_page: "25", total: "76" },
    });

    await expect(
      client.listNodeBuilds("u1", "example.com", {
        page: 1,
        perPage: 10,
      }),
    ).resolves.toMatchObject({
      pagination: {
        page: 2,
        perPage: 25,
        total: 76,
        totalPages: 4,
        hasPrevious: true,
        hasNext: true,
      },
    });
  });

  it.each(["1.0", "1e0", " 1", "+1", "-1", "1x"])(
    "rejects non-digit pagination string %j",
    async (currentPage) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { client } = clientWith({
        data: [],
        meta: { current_page: currentPage, per_page: 25, total: 0 },
      });

      await expect(
        client.listNodeBuilds("u1", "example.com", {
          page: 1,
          perPage: 25,
        }),
      ).rejects.toMatchObject({ code: "HOSTINGER_ERROR", status: 502 });
      consoleError.mockRestore();
    },
  );

  it.each([
    {
      data: [{ uuid: "not-a-uuid", state: "running" }],
      meta: { current_page: 1, per_page: 25, total: 1 },
    },
    {
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "unknown",
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 1 },
    },
    {
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "running",
        },
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "running",
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 2 },
    },
    {
      data: [],
      meta: { current_page: 10_001, per_page: 25, total: 0 },
    },
    {
      data: [],
      meta: { current_page: 1, per_page: 101, total: 0 },
    },
    {
      data: [],
      meta: { current_page: 1, per_page: 25, total: 100_000_001 },
    },
    {
      data: [
        {
          uuid: "69f07fe2-197a-4fb3-9dae-606f965ad13d",
          state: "running",
          options: [],
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 1 },
    },
    {
      meta: { current_page: 1, per_page: 25, total: 0 },
    },
    {
      data: [],
    },
  ])("rejects a malformed build page", async (body) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { client } = clientWith(body);
    await expect(
      client.listNodeBuilds("u1", "example.com", {
        page: 1,
        perPage: 25,
      }),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      message: "Hostinger returned an invalid response.",
    });
    consoleError.mockRestore();
  });

  it("logs only an allowlisted diagnostic and returns its reference ID", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const sensitiveUuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";
    const { client } = clientWith({
      data: [
        {
          uuid: sensitiveUuid,
          options: {
            domain: "private.example",
            username: "private-user",
            token: "private-token",
            url: "https://private.example/query?secret=yes",
          },
          stack: "private-stack",
          arbitrary: "private-arbitrary-value",
        },
      ],
      meta: { current_page: 1, per_page: 25, total: 1 },
    });

    let caught: unknown;
    try {
      await client.listNodeBuilds("u1", "example.com", {
        page: 1,
        perPage: 25,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 502,
      referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe(
      "hostinger_build_response_diagnostic",
    );
    expect(consoleError.mock.calls[0][1]).toEqual({
      referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
      phase: "build_list_decode",
      correlationId: "corr-1",
      category: "missing_required_fields",
      itemCount: 1,
      missingFields: ["state"],
      zodPaths: ["data.*.state"],
      zodCodes: ["invalid_value"],
    });
    expect((caught as { referenceId?: string }).referenceId).toBe(
      (consoleError.mock.calls[0][1] as { referenceId: string }).referenceId,
    );
    const serializedDiagnostic = JSON.stringify(consoleError.mock.calls);
    expect(serializedDiagnostic).not.toMatch(
      new RegExp(
        [
          sensitiveUuid,
          "private\\.example",
          "private-user",
          "private-token",
          "https://",
          "secret=yes",
          "private-stack",
          "private-arbitrary-value",
          "options",
        ].join("|"),
        "i",
      ),
    );
    consoleError.mockRestore();
  });

  it("retrieves build logs with a validated UUID and from_line", async () => {
    const buildUuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";
    const { client, fetchImpl } = clientWith({
      logs: "\u001b[32mbuild complete\u001b[0m",
      lines: 12,
    });
    await expect(
      client.getNodeBuildLogs("u1", "example.com", buildUuid, 10),
    ).resolves.toEqual({
      logs: "\u001b[32mbuild complete\u001b[0m",
      lines: 12,
      correlationId: "corr-1",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://developers.hostinger.com/api/hosting/v1/accounts/u1/websites/example.com/nodejs/builds/${buildUuid}/logs?from_line=10`,
    );
  });

  it("rejects malformed log payloads", async () => {
    const { client } = clientWith({ logs: ["raw"], lines: -1 });
    await expect(
      client.getNodeBuildLogs(
        "u1",
        "example.com",
        "69f07fe2-197a-4fb3-9dae-606f965ad13d",
        0,
      ),
    ).rejects.toMatchObject({ code: "HOSTINGER_ERROR", status: 502 });
  });

  it("maps an aborted request to a controlled timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = new HostingerClient({
      token: "never-log-this",
      fetchImpl,
      timeoutMs: 1,
    });
    await expect(
      client.listNodeBuilds("u1", "example.com", {
        page: 1,
        perPage: 25,
      }),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      status: 504,
      message: "The Hostinger request timed out.",
    });
  });

  it("never serializes the bearer token in results or controlled errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(200, {
        data: [{ domain: "example.com", username: "u1" }],
      }),
    );
    const client = new HostingerClient({
      token: "ultra-secret-token",
      fetchImpl,
    });
    const result = await client.listWebsitesForConfiguredSite(
      "example.com",
      "u1",
    );
    expect(JSON.stringify(result)).not.toContain("ultra-secret-token");
    const requestHeaders = (fetchImpl.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(requestHeaders.Authorization).toBe("Bearer ultra-secret-token");
  });

  it("rejects invalid JSON without exposing its body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("server-token-value and raw body", { status: 200 }),
      );
    const client = new HostingerClient({
      token: "server-token-value",
      fetchImpl,
    });
    await expect(
      client.listWebsitesForConfiguredSite("example.com", "u1"),
    ).rejects.toMatchObject({
      code: "HOSTINGER_ERROR",
      message: "Hostinger returned an invalid response.",
    });
  });
});
