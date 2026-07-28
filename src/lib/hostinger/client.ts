import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getHostingerEnv } from "@/lib/env";
import { reportBuildResponseDiagnostic } from "./build-response-diagnostic";
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

export const nodeBuildStates = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type NodeBuildState = (typeof nodeBuildStates)[number];

export type NodeBuildOrigin = "archive" | "github" | "other";

export type NodeBuildSummary = {
  uuid: string;
  state: NodeBuildState;
  origin?: NodeBuildOrigin;
  createdAt?: string;
  updatedAt?: string;
};

export type NodeBuildPage = {
  builds: NodeBuildSummary[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  correlationId?: string;
};

export type NodeBuildLogs = {
  logs: string;
  lines: number;
  correlationId?: string;
};

export type NodeRestartResult = {
  restarted: true;
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

type HostingerMethod = "GET" | "POST";

const PAGINATION_DIGITS_PATTERN = /^\d+$/;
const MAX_BUILD_PAGE = 10_000;
const MAX_BUILD_PAGE_SIZE = 100;
const MAX_BUILD_TOTAL = 100_000_000;

const hostingerBuildOptionsSchema = z
  .object({
    source_type: z.unknown().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const hostingerBuildSchema = z.object({
  uuid: z.string().uuid(),
  state: z.enum(nodeBuildStates),
  options: hostingerBuildOptionsSchema,
  created_at: z.unknown().optional(),
  updated_at: z.unknown().optional(),
});

function strictPaginationInteger(min: number, max: number) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && PAGINATION_DIGITS_PATTERN.test(value)
        ? Number(value)
        : value,
    z.number().int().min(min).max(max),
  );
}

const hostingerBuildPageSchema = z.object({
  data: z
    .array(hostingerBuildSchema)
    .max(MAX_BUILD_PAGE_SIZE)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.uuid)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate build UUID.",
            path: [index, "uuid"],
          });
        }
        seen.add(item.uuid);
      }
    }),
  meta: z.object({
    current_page: strictPaginationInteger(1, MAX_BUILD_PAGE),
    per_page: strictPaginationInteger(1, MAX_BUILD_PAGE_SIZE),
    total: strictPaginationInteger(0, MAX_BUILD_TOTAL),
  }),
});

const hostingerTimestampSchema = z.iso.datetime({ offset: true });
const BUILD_SOURCE_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

const hostingerBuildLogsSchema = z.object({
  logs: z.string().max(1_000_000).nullable(),
  lines: z.number().int().nonnegative().max(10_000_000),
});

const hostingerEmptySuccessSchema = z
  .object({
    message: z.string().max(500).optional(),
  })
  .passthrough();

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

function sanitizeCorrelationId(value: unknown) {
  return typeof value === "string" &&
    CORRELATION_ID_PATTERN.test(value) &&
    !value.includes("://")
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

function malformedResponse(correlationId?: string, referenceId?: string) {
  return new AppError(
    "HOSTINGER_ERROR",
    "Hostinger returned an invalid response.",
    502,
    correlationId,
    referenceId,
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

  private async request(
    method: HostingerMethod,
    path: string,
  ): Promise<HostingerResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
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
      "GET",
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
      "GET",
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

  async listNodeBuilds(
    configuredUsername: string,
    configuredDomain: string,
    pagination: { page: number; perPage: number },
  ): Promise<NodeBuildPage> {
    const domain = normalizeDomain(configuredDomain);
    const parameters = new URLSearchParams({
      page: String(pagination.page),
      per_page: String(pagination.perPage),
    });
    const response = await this.request(
      "GET",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(
        domain,
      )}/nodejs/builds?${parameters.toString()}`,
    );
    const parsed = hostingerBuildPageSchema.safeParse(response.payload);
    if (!parsed.success) {
      const referenceId = reportBuildResponseDiagnostic(
        response.payload,
        parsed.error,
        response.correlationId,
      );
      throw malformedResponse(response.correlationId, referenceId);
    }

    const { current_page: page, per_page: perPage, total } = parsed.data.meta;
    const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
    return {
      builds: parsed.data.data.map((build) => ({
        uuid: build.uuid,
        state: build.state,
        origin: normalizeBuildOrigin(build.options),
        createdAt: normalizeBuildTimestamp(build.created_at),
        updatedAt: normalizeBuildTimestamp(build.updated_at),
      })),
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
      },
      correlationId: response.correlationId,
    };
  }

  async getNodeBuildLogs(
    configuredUsername: string,
    configuredDomain: string,
    buildUuid: string,
    fromLine: number,
  ): Promise<NodeBuildLogs> {
    const domain = normalizeDomain(configuredDomain);
    const uuid = z.string().uuid().safeParse(buildUuid);
    if (!uuid.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "The build identifier is invalid.",
        400,
      );
    }
    const parameters = new URLSearchParams({
      from_line: String(fromLine),
    });
    const response = await this.request(
      "GET",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(
        domain,
      )}/nodejs/builds/${encodeURIComponent(
        uuid.data,
      )}/logs?${parameters.toString()}`,
    );
    const parsed = hostingerBuildLogsSchema.safeParse(response.payload);
    if (!parsed.success) throw malformedResponse(response.correlationId);
    return {
      logs: parsed.data.logs ?? "",
      lines: parsed.data.lines,
      correlationId: response.correlationId,
    };
  }

  async restartNodeServer(
    configuredUsername: string,
    configuredDomain: string,
  ): Promise<NodeRestartResult> {
    const domain = normalizeDomain(configuredDomain);
    const response = await this.request(
      "POST",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(domain)}/nodejs/server/restart`,
    );
    if (
      response.payload !== null &&
      !hostingerEmptySuccessSchema.safeParse(response.payload).success
    ) {
      throw malformedResponse(response.correlationId);
    }
    return {
      restarted: true,
      correlationId: response.correlationId,
    };
  }
}

function normalizeBuildOrigin(
  options: z.infer<typeof hostingerBuildOptionsSchema>,
): NodeBuildOrigin | undefined {
  const sourceType = options?.source_type;
  if (typeof sourceType !== "string") return undefined;
  const normalized = sourceType.trim().toLowerCase();
  if (!BUILD_SOURCE_TYPE_PATTERN.test(normalized)) return undefined;
  if (normalized === "archive" || normalized === "github") return normalized;
  return "other";
}

function normalizeBuildTimestamp(value: unknown) {
  const parsed = hostingerTimestampSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
