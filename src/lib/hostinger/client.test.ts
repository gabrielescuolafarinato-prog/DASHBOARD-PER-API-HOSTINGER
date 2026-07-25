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
