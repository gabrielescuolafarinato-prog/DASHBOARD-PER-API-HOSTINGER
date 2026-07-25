import "server-only";
import { AppError } from "@/lib/errors";
import { getHostingerEnv } from "@/lib/env";
import { normalizeDomain } from "./domain";

export const HOSTINGER_API_BASE_URL = "https://developers.hostinger.com";

export type HostingerWebsite = {
  domain: string;
  username?: string;
  orderId?: string;
  status?: string;
  nodeEnabled?: boolean;
  raw: Record<string, unknown>;
};

type ClientOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return fallback;
}

function correlationId(response: Response, payload: unknown) {
  const header =
    response.headers.get("x-correlation-id") ??
    response.headers.get("correlation-id");
  if (header) return header;
  if (payload && typeof payload === "object" && "correlation_id" in payload) {
    const id = (payload as { correlation_id?: unknown }).correlation_id;
    return typeof id === "string" ? id : undefined;
  }
}

export class HostingerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = options.baseUrl ?? HOSTINGER_API_BASE_URL;
  }

  private async request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
          ...init.headers,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new AppError(
            "HOSTINGER_ERROR",
            "Hostinger returned an invalid response.",
            502,
            response.headers.get("x-correlation-id") ?? undefined,
          );
        }
      }
      if (!response.ok) {
        const id = correlationId(response, payload);
        if (response.status === 429) {
          throw new AppError(
            "RATE_LIMITED",
            "Hostinger rate limit reached. Try again later.",
            429,
            id,
          );
        }
        const status = response.status >= 500 ? 502 : response.status;
        throw new AppError(
          "HOSTINGER_ERROR",
          errorMessage(payload, `Hostinger request failed (${response.status}).`),
          status,
          id,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError("HOSTINGER_ERROR", "Hostinger request timed out.", 504);
      }
      throw new AppError("HOSTINGER_ERROR", "Hostinger is unreachable.", 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async listWebsitesByDomain(domain: string): Promise<HostingerWebsite[]> {
    const normalized = normalizeDomain(domain);
    const payload = await this.request(
      `/api/hosting/v1/websites?domain=${encodeURIComponent(normalized)}`,
    );
    const container =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : payload;
    const records = Array.isArray(container) ? container : [];
    return records
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        domain: String(item.domain ?? item.primary_domain ?? ""),
        username:
          typeof item.username === "string"
            ? item.username
            : typeof item.hostinger_username === "string"
              ? item.hostinger_username
              : undefined,
        orderId:
          typeof item.order_id === "string" ? item.order_id : undefined,
        status: typeof item.status === "string" ? item.status : undefined,
        nodeEnabled:
          typeof item.node_enabled === "boolean" ? item.node_enabled : undefined,
        raw: item,
      }))
      .filter((site) => normalizeDomain(site.domain) === normalized);
  }
}

export function createHostingerClient() {
  const env = getHostingerEnv();
  if (!env.HOSTINGER_API_TOKEN) {
    throw new AppError(
      "HOSTINGER_ERROR",
      "Hostinger is not configured.",
      503,
    );
  }
  return new HostingerClient({ token: env.HOSTINGER_API_TOKEN });
}
