import "server-only";
import { AppError } from "@/lib/errors";
import { getHostingerEnv } from "@/lib/env";
import { normalizeDomain } from "./domain";

export const HOSTINGER_API_BASE_URL = "https://developers.hostinger.com";

export type HostingerWebsite = {
  domain: string;
  username: string;
  orderId?: string;
};

export type ConfiguredWebsiteMatches = {
  matches: HostingerWebsite[];
  correlationId?: string;
};

export type NodeSiteProbe = {
  nodeEnabled: true;
  buildCount: number;
  correlationId?: string;
};

type ClientOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

type HostingerResponse = {
  payload: unknown;
  correlationId?: string;
};

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

function sanitizeCorrelationId(value: unknown) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function correlationId(response: Response, payload: unknown) {
  const header =
    response.headers.get("x-correlation-id") ??
    response.headers.get("correlation-id");
  const safeHeader = sanitizeCorrelationId(header);
  if (safeHeader) return safeHeader;
  if (payload && typeof payload === "object" && "correlation_id" in payload) {
    return sanitizeCorrelationId(
      (payload as { correlation_id?: unknown }).correlation_id,
    );
  }
}

function malformedResponse(correlationId?: string) {
  return new AppError(
    "HOSTINGER_ERROR",
    "Hostinger returned an invalid response.",
    502,
    correlationId,
  );
}

function httpError(status: number, id?: string) {
  if (status === 401 || status === 403) {
    return new AppError(
      "HOSTINGER_ERROR",
      "Hostinger credentials are invalid or insufficient.",
      status,
      id,
    );
  }
  if (status === 404) {
    return new AppError(
      "NOT_FOUND",
      "The configured Hostinger site was not found.",
      404,
      id,
    );
  }
  if (status === 422) {
    return new AppError(
      "HOSTINGER_ERROR",
      "Hostinger rejected the configured site request.",
      422,
      id,
    );
  }
  if (status === 429) {
    return new AppError(
      "RATE_LIMITED",
      "The Hostinger request is temporarily rate limited.",
      429,
      id,
    );
  }
  if (status >= 500) {
    return new AppError(
      "HOSTINGER_ERROR",
      "Hostinger is temporarily unavailable.",
      503,
      id,
    );
  }
  return new AppError(
    "HOSTINGER_ERROR",
    "The Hostinger request could not be completed.",
    502,
    id,
  );
}

function responseRecords(payload: unknown, id?: string) {
  const container =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
      ? (payload as { data: unknown }).data
      : payload;
  if (!Array.isArray(container)) throw malformedResponse(id);
  if (
    container.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  ) {
    throw malformedResponse(id);
  }
  return container as Record<string, unknown>[];
}

function readWebsite(
  item: Record<string, unknown>,
  correlationId?: string,
): HostingerWebsite {
  const rawDomain =
    typeof item.domain === "string"
      ? item.domain
      : typeof item.primary_domain === "string"
        ? item.primary_domain
        : undefined;
  const username =
    typeof item.username === "string"
      ? item.username
      : typeof item.hostinger_username === "string"
        ? item.hostinger_username
        : undefined;
  if (!rawDomain || !username || !username.trim()) {
    throw malformedResponse(correlationId);
  }

  let domain: string;
  try {
    domain = normalizeDomain(rawDomain);
  } catch {
    throw malformedResponse(correlationId);
  }

  const rawOrderId = item.order_id ?? item.orderId;
  if (
    rawOrderId !== undefined &&
    typeof rawOrderId !== "string" &&
    typeof rawOrderId !== "number"
  ) {
    throw malformedResponse(correlationId);
  }

  return {
    domain,
    username,
    orderId:
      rawOrderId === undefined || rawOrderId === ""
        ? undefined
        : String(rawOrderId),
  };
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

  private async request(path: string): Promise<HostingerResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (!response.ok) {
            throw httpError(
              response.status,
              sanitizeCorrelationId(
                response.headers.get("x-correlation-id"),
              ),
            );
          }
          throw malformedResponse(
            sanitizeCorrelationId(
              response.headers.get("x-correlation-id"),
            ),
          );
        }
      }

      const id = correlationId(response, payload);
      if (!response.ok) throw httpError(response.status, id);
      return { payload, correlationId: id };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError(
          "HOSTINGER_ERROR",
          "The Hostinger request timed out.",
          504,
        );
      }
      throw new AppError(
        "HOSTINGER_ERROR",
        "Hostinger is temporarily unreachable.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async listWebsitesForConfiguredSite(
    configuredDomain: string,
    configuredUsername: string,
  ): Promise<ConfiguredWebsiteMatches> {
    const domain = normalizeDomain(configuredDomain);
    const parameters = new URLSearchParams({
      domain,
      username: configuredUsername,
    });
    const response = await this.request(
      `/api/hosting/v1/websites?${parameters.toString()}`,
    );
    const records = responseRecords(
      response.payload,
      response.correlationId,
    );
    const matches = records
      .map((item) => readWebsite(item, response.correlationId))
      .filter(
        (site) =>
          site.domain === domain &&
          site.username === configuredUsername,
      );
    return { matches, correlationId: response.correlationId };
  }

  async verifyConfiguredNodeSite(
    configuredUsername: string,
    configuredDomain: string,
  ): Promise<NodeSiteProbe> {
    const domain = normalizeDomain(configuredDomain);
    const response = await this.request(
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(domain)}/nodejs/builds`,
    );
    const records = responseRecords(
      response.payload,
      response.correlationId,
    );
    return {
      nodeEnabled: true,
      buildCount: records.length,
      correlationId: response.correlationId,
    };
  }
}

export function createHostingerClient() {
  const env = getHostingerEnv();
  if (
    !env.HOSTINGER_API_TOKEN ||
    !env.HOSTINGER_ACCOUNT_USERNAME ||
    !env.HOSTINGER_SITE_DOMAIN
  ) {
    throw new AppError(
      "HOSTINGER_ERROR",
      "Hostinger is not configured.",
      503,
    );
  }
  return new HostingerClient({ token: env.HOSTINGER_API_TOKEN });
}
