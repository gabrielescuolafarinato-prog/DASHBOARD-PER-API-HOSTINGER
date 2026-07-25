import { describe, expect, it, vi } from "vitest";
import { HostingerClient } from "./client";
import type { AppErrorCode } from "@/lib/errors";

function response(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Hostinger client", () => {
  it.each<[number, AppErrorCode]>([
    [401, "HOSTINGER_ERROR"],
    [422, "HOSTINGER_ERROR"],
    [429, "RATE_LIMITED"],
    [500, "HOSTINGER_ERROR"],
  ])("maps HTTP %i to an application error", async (status, code) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(status, { error: "failure", correlation_id: "corr-1" }),
      );
    const client = new HostingerClient({
      token: "do-not-leak",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.listWebsitesByDomain("example.com")).rejects.toEqual(
      expect.objectContaining({ code, correlationId: "corr-1" }),
    );
  });

  it("post-filters sites by exact normalized domain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(200, {
        data: [
          { domain: "example.com", username: "u1" },
          { domain: "evil-example.com", username: "u2" },
          { domain: "other.test", username: "u3" },
        ],
      }),
    );
    const client = new HostingerClient({
      token: "server-token-value",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.listWebsitesByDomain("https://www.Example.com/");
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("example.com");
  });

  it("never includes the bearer token in returned client payloads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, { data: [{ domain: "example.com" }] }));
    const client = new HostingerClient({
      token: "ultra-secret-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.listWebsitesByDomain("example.com");
    expect(JSON.stringify(result)).not.toContain("ultra-secret-token");
    const requestHeaders = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(requestHeaders.Authorization).toBe("Bearer ultra-secret-token");
  });
});
