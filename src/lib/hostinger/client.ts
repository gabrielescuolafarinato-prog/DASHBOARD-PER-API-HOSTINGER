import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getHostingerEnv } from "@/lib/env";
import { reportBuildResponseDiagnostic } from "./build-response-diagnostic";
import { reportDatabaseRequestDiagnostic } from "./database-request-diagnostic";
import { normalizeDomain } from "./domain";
import {
  vulnerabilitySeverities,
  type VulnerabilitySeverity,
} from "./vulnerability-constants";
import {
  decodePhpMyAdminLink,
  PhpMyAdminLinkError,
  validatePhpMyAdminLink,
  type PhpMyAdminResponseShape,
} from "./phpmyadmin-link";

export {
  vulnerabilitySeverities,
  type VulnerabilitySeverity,
} from "./vulnerability-constants";
export { validatePhpMyAdminLink } from "./phpmyadmin-link";

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

export type HostingerDatabaseSummary = {
  name: string;
  user: string;
  domain: string;
  diskUsageMb?: number;
  maxSizeMb?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type HostingerDatabasePage = {
  databases: HostingerDatabaseSummary[];
  pagination: NodeBuildPage["pagination"];
  discarded: {
    invalid: number;
    missingDomain: number;
    otherDomain: number;
  };
  correlationId?: string;
};

export type HostingerRemoteConnection = {
  databaseName: string;
  databaseUser: string;
  ip: string;
};

export type HostingerRemoteConnectionList = {
  connections: HostingerRemoteConnection[];
  discardedInvalid: number;
  correlationId?: string;
};

export type HostingerMutationResult = {
  accepted: true;
  correlationId?: string;
};

export type HostingerPhpMyAdminLink = {
  link: string;
  responseShape: PhpMyAdminResponseShape;
  correlationId?: string;
};

export type HostingerVulnerability = {
  id: string;
  packageName: string;
  installedVersion: string;
  severity: VulnerabilitySeverity;
  cvssScore?: number;
  cve?: string;
  isDirect: boolean;
  isPatchable: boolean;
  fixVersion?: string;
  isPatchingInProgress: boolean;
  publishedAt?: string;
  advisoryUrl?: string;
};

export type HostingerVulnerabilityList = {
  vulnerabilities: HostingerVulnerability[];
  correlationId?: string;
};

export type HostingerVulnerabilityPatchResult = {
  accepted: true;
  patchedVulnerabilityIds: string[];
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  headBranch?: string;
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

type HostingerMethod = "GET" | "POST" | "PATCH" | "DELETE";

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

const hostingerIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );

const hostingerDatabaseRecordSchema = z.object({
  name: hostingerIdentifierSchema,
  user: hostingerIdentifierSchema,
  domain: z.unknown().optional(),
  created_at: hostingerTimestampSchema.nullable().optional(),
  updated_at: hostingerTimestampSchema.nullable().optional(),
  disk_usage_mb: z
    .number()
    .int()
    .nonnegative()
    .max(2_147_483_647)
    .nullable()
    .optional(),
  max_size_mb: z
    .number()
    .int()
    .nonnegative()
    .max(2_147_483_647)
    .nullable()
    .optional(),
});

const hostingerDatabasePageContainerSchema = z.object({
  data: z.array(z.unknown()).max(MAX_BUILD_PAGE_SIZE),
  meta: z.object({
    current_page: strictPaginationInteger(1, MAX_BUILD_PAGE),
    per_page: strictPaginationInteger(1, MAX_BUILD_PAGE_SIZE),
    total: strictPaginationInteger(0, MAX_BUILD_TOTAL),
  }),
});

const hostingerRemoteConnectionSchema = z.object({
  database_name: hostingerIdentifierSchema,
  database_user: hostingerIdentifierSchema,
  ip: z.string().min(1).max(255),
});

const hostingerRemoteConnectionCollectionSchema = z
  .array(z.unknown())
  .max(10_000);

const vulnerabilityIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
const packageVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value
        .split("/")
        .some(
          (part) =>
            part.length === 0 ||
            part.startsWith(".") ||
            part.endsWith(".lock"),
        ),
  );
const cveSchema = z
  .string()
  .max(64)
  .regex(/^CVE-\d{4}-\d{4,}$/i);
const hostingerVulnerabilitySchema = z.object({
  package_name: packageNameSchema,
  installed_version: packageVersionSchema,
  is_direct: z.boolean(),
  is_patchable: z.boolean(),
  fix_version: packageVersionSchema.nullable().optional(),
  vulnerability_id: vulnerabilityIdSchema,
  severity: z.enum(vulnerabilitySeverities),
  cvss_score: z.number().min(0).max(10).nullable().optional(),
  cve: cveSchema.nullable().optional(),
  url: z.string().max(4_096).nullable().optional(),
  published_at: hostingerTimestampSchema.nullable().optional(),
  is_patching_in_progress: z.boolean(),
});
const hostingerVulnerabilityCollectionSchema = z
  .array(hostingerVulnerabilitySchema)
  .max(10_000)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.vulnerability_id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate vulnerability identifier.",
          path: [index, "vulnerability_id"],
        });
      }
      seen.add(item.vulnerability_id);
    }
  });
const hostingerPatchResultSchema = z.object({
  pr_url: z.string().max(4_096).optional(),
  pr_number: z.number().int().positive().max(2_147_483_647).optional(),
  head_branch: gitBranchSchema.optional(),
  patched_vulnerability_ids: z
    .array(vulnerabilityIdSchema)
    .min(1)
    .max(1_000)
    .refine((items) => new Set(items).size === items.length),
});

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
  if (status === 409) {
    return new AppError(
      "CONFLICT",
      "Hostinger reports that another operation is already in progress.",
      409,
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
    body?: Record<string, unknown>,
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
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
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

  async listDatabases(
    configuredUsername: string,
    configuredDomain: string,
    pagination: { page: number; perPage: number; search?: string },
    options: { allowUnfilteredFallback?: boolean } = {},
  ): Promise<HostingerDatabasePage> {
    const domain = normalizeDomain(configuredDomain);
    try {
      return await this.listDatabasePage(
        configuredUsername,
        domain,
        pagination,
        true,
      );
    } catch (error) {
      if (
        !options.allowUnfilteredFallback ||
        !isExactUnprocessableHostingerError(error)
      ) {
        if (options.allowUnfilteredFallback) {
          const referenceId = reportDatabaseRequestDiagnostic({
            phase: "database_list_filtered",
            upstreamStatus: diagnosticStatus(error),
            correlationId: diagnosticCorrelationId(error),
            endpointKind: "database_list",
            attempt: "filtered",
            forbiddenValues: [
              configuredUsername,
              domain,
              pagination.search,
            ],
            result: "failure",
          });
          throw controlledDatabaseReadError(error, referenceId);
        }
        throw error;
      }

      const referenceId = reportDatabaseRequestDiagnostic({
        phase: "database_list_filtered",
        upstreamStatus: 422,
        correlationId: error.correlationId,
        endpointKind: "database_list",
        attempt: "filtered",
        forbiddenValues: [
          configuredUsername,
          domain,
          pagination.search,
        ],
        result: "retry",
      });
      try {
        const fallback = await this.listDatabasePage(
          configuredUsername,
          domain,
          pagination,
          false,
        );
        reportDatabaseRequestDiagnostic({
          referenceId,
          phase: "database_list_fallback",
          upstreamStatus: 200,
          correlationId: fallback.correlationId,
          endpointKind: "database_list",
          attempt: "fallback",
          forbiddenValues: [
            configuredUsername,
            domain,
            pagination.search,
            ...fallback.databases.flatMap((database) => [
              database.name,
              database.user,
            ]),
          ],
          result: "success",
        });
        return fallback;
      } catch (fallbackError) {
        reportDatabaseRequestDiagnostic({
          referenceId,
          phase: "database_list_fallback",
          upstreamStatus: diagnosticStatus(fallbackError),
          correlationId: diagnosticCorrelationId(fallbackError),
          endpointKind: "database_list",
          attempt: "fallback",
          forbiddenValues: [
            configuredUsername,
            domain,
            pagination.search,
          ],
          result: "failure",
        });
        throw controlledDatabaseReadError(
          fallbackError,
          referenceId,
        );
      }
    }
  }

  private async listDatabasePage(
    configuredUsername: string,
    domain: string,
    pagination: { page: number; perPage: number; search?: string },
    filtered: boolean,
  ): Promise<HostingerDatabasePage> {
    const parameters = new URLSearchParams({
      page: String(pagination.page),
      per_page: String(pagination.perPage),
    });
    if (filtered) {
      parameters.set("domain", domain);
      parameters.set("is_assigned", "true");
    }
    if (pagination.search) parameters.set("search", pagination.search);
    const response = await this.request(
      "GET",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/databases?${parameters.toString()}`,
    );
    const container = hostingerDatabasePageContainerSchema.safeParse(
      response.payload,
    );
    if (!container.success) {
      throw malformedResponse(response.correlationId);
    }

    const databases: HostingerDatabaseSummary[] = [];
    const seen = new Set<string>();
    const discarded = {
      invalid: 0,
      missingDomain: 0,
      otherDomain: 0,
    };
    for (const candidate of container.data.data) {
      const parsed = hostingerDatabaseRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        discarded.invalid += 1;
        continue;
      }
      const rawDomain = parsed.data.domain;
      if (
        rawDomain === null ||
        rawDomain === undefined ||
        rawDomain === ""
      ) {
        discarded.missingDomain += 1;
        continue;
      }
      if (typeof rawDomain !== "string") {
        discarded.invalid += 1;
        continue;
      }
      let itemDomain: string;
      try {
        itemDomain = normalizeDomain(rawDomain);
      } catch {
        discarded.invalid += 1;
        continue;
      }
      if (itemDomain !== domain) {
        discarded.otherDomain += 1;
        continue;
      }
      if (seen.has(parsed.data.name)) {
        discarded.invalid += 1;
        continue;
      }
      seen.add(parsed.data.name);
      databases.push({
        name: parsed.data.name,
        user: parsed.data.user,
        domain: itemDomain,
        diskUsageMb: parsed.data.disk_usage_mb ?? undefined,
        maxSizeMb: parsed.data.max_size_mb ?? undefined,
        createdAt: parsed.data.created_at ?? undefined,
        updatedAt: parsed.data.updated_at ?? undefined,
      });
    }

    const {
      current_page: page,
      per_page: perPage,
      total,
    } = container.data.meta;
    const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
    return {
      databases,
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
      },
      discarded,
      correlationId: response.correlationId,
    };
  }

  async createDatabase(
    configuredUsername: string,
    input: {
      name: string;
      user: string;
      password: string;
      websiteDomain: string;
    },
  ): Promise<HostingerMutationResult> {
    return await this.databaseMutation(
      "POST",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/databases`,
      {
        name: input.name,
        user: input.user,
        password: input.password,
        website_domain: normalizeDomain(input.websiteDomain),
      },
    );
  }

  async changeDatabasePassword(
    configuredUsername: string,
    databaseName: string,
    password: string,
  ): Promise<HostingerMutationResult> {
    return await this.databaseMutation(
      "PATCH",
      databasePath(
        configuredUsername,
        databaseName,
        "/change-password",
      ),
      { password },
    );
  }

  async deleteDatabase(
    configuredUsername: string,
    databaseName: string,
  ): Promise<HostingerMutationResult> {
    return await this.databaseMutation(
      "DELETE",
      databasePath(configuredUsername, databaseName),
    );
  }

  async repairDatabase(
    configuredUsername: string,
    databaseName: string,
  ): Promise<HostingerMutationResult> {
    return await this.databaseMutation(
      "PATCH",
      databasePath(configuredUsername, databaseName, "/repair"),
    );
  }

  async listDatabaseRemoteConnections(
    configuredUsername: string,
    configuredDomain: string,
  ): Promise<HostingerRemoteConnectionList> {
    const domain = normalizeDomain(configuredDomain);
    try {
      return await this.listDatabaseRemoteConnectionAttempt(
        configuredUsername,
        domain,
      );
    } catch (error) {
      if (!isExactUnprocessableHostingerError(error)) {
        const referenceId = reportDatabaseRequestDiagnostic({
          phase: "remote_list_filtered",
          upstreamStatus: diagnosticStatus(error),
          correlationId: diagnosticCorrelationId(error),
          endpointKind: "remote_connection_list",
          attempt: "filtered",
          forbiddenValues: [configuredUsername, domain],
          result: "failure",
        });
        throw controlledDatabaseReadError(error, referenceId);
      }

      const referenceId = reportDatabaseRequestDiagnostic({
        phase: "remote_list_filtered",
        upstreamStatus: 422,
        correlationId: error.correlationId,
        endpointKind: "remote_connection_list",
        attempt: "filtered",
        forbiddenValues: [configuredUsername, domain],
        result: "retry",
      });
      try {
        const fallback =
          await this.listDatabaseRemoteConnectionAttempt(
            configuredUsername,
          );
        reportDatabaseRequestDiagnostic({
          referenceId,
          phase: "remote_list_fallback",
          upstreamStatus: 200,
          correlationId: fallback.correlationId,
          endpointKind: "remote_connection_list",
          attempt: "fallback",
          forbiddenValues: [
            configuredUsername,
            domain,
            ...fallback.connections.flatMap((connection) => [
              connection.databaseName,
              connection.databaseUser,
              connection.ip,
            ]),
          ],
          result: "success",
        });
        return fallback;
      } catch (fallbackError) {
        reportDatabaseRequestDiagnostic({
          referenceId,
          phase: "remote_list_fallback",
          upstreamStatus: diagnosticStatus(fallbackError),
          correlationId: diagnosticCorrelationId(fallbackError),
          endpointKind: "remote_connection_list",
          attempt: "fallback",
          forbiddenValues: [configuredUsername, domain],
          result: "failure",
        });
        throw controlledDatabaseReadError(
          fallbackError,
          referenceId,
        );
      }
    }
  }

  private async listDatabaseRemoteConnectionAttempt(
    configuredUsername: string,
    domain?: string,
  ): Promise<HostingerRemoteConnectionList> {
    const parameters = domain
      ? `?${new URLSearchParams({ domain }).toString()}`
      : "";
    const response = await this.request(
      "GET",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/databases/remote-connections${parameters}`,
    );
    const collection =
      hostingerRemoteConnectionCollectionSchema.safeParse(
        response.payload,
      );
    if (!collection.success) {
      throw malformedResponse(response.correlationId);
    }
    const connections: HostingerRemoteConnection[] = [];
    let discardedInvalid = 0;
    for (const candidate of collection.data) {
      const parsed =
        hostingerRemoteConnectionSchema.safeParse(candidate);
      if (!parsed.success) {
        discardedInvalid += 1;
        continue;
      }
      connections.push({
        databaseName: parsed.data.database_name,
        databaseUser: parsed.data.database_user,
        ip: parsed.data.ip,
      });
    }
    return {
      connections,
      discardedInvalid,
      correlationId: response.correlationId,
    };
  }

  async addDatabaseRemoteConnection(
    configuredUsername: string,
    databaseName: string,
    ip: string,
  ): Promise<HostingerMutationResult> {
    return await this.databaseMutation(
      "POST",
      databasePath(
        configuredUsername,
        databaseName,
        "/remote-connections",
      ),
      { ip },
    );
  }

  async removeDatabaseRemoteConnection(
    configuredUsername: string,
    databaseName: string,
    ip: string,
  ): Promise<HostingerMutationResult> {
    const parameters = new URLSearchParams({ ip });
    return await this.databaseMutation(
      "DELETE",
      `${databasePath(
        configuredUsername,
        databaseName,
        "/remote-connections",
      )}?${parameters.toString()}`,
    );
  }

  async getDatabasePhpMyAdminLink(
    configuredUsername: string,
    databaseName: string,
  ): Promise<HostingerPhpMyAdminLink> {
    let response: HostingerResponse;
    try {
      response = await this.request(
        "GET",
        databasePath(
          configuredUsername,
          databaseName,
          "/phpmyadmin-link",
        ),
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        error.status === 502 &&
        error.message === "Hostinger returned an invalid response."
      ) {
        throw new PhpMyAdminLinkError(
          "response_shape",
          error.correlationId,
        );
      }
      throw error;
    }
    const decoded = decodePhpMyAdminLink(
      response.payload,
      response.correlationId,
    );
    return {
      link: validatePhpMyAdminLink(
        decoded.link,
        response.correlationId,
        decoded.responseShape,
      ),
      responseShape: decoded.responseShape,
      correlationId: response.correlationId,
    };
  }

  async clearWebsiteCache(
    configuredUsername: string,
    configuredDomain: string,
  ): Promise<HostingerMutationResult> {
    return await this.siteMutation(
      "DELETE",
      configuredUsername,
      configuredDomain,
      "/cache/clear",
    );
  }

  async toggleWebsiteCache(
    configuredUsername: string,
    configuredDomain: string,
    enabled: boolean,
  ): Promise<HostingerMutationResult> {
    return await this.siteMutation(
      "PATCH",
      configuredUsername,
      configuredDomain,
      "/cache/toggle",
      { enabled },
    );
  }

  async toggleWebsiteCachelessMode(
    configuredUsername: string,
    configuredDomain: string,
    enabled: boolean,
  ): Promise<HostingerMutationResult> {
    return await this.siteMutation(
      "PATCH",
      configuredUsername,
      configuredDomain,
      "/cacheless-mode/toggle",
      { enabled },
    );
  }

  async listNodeVulnerabilities(
    configuredUsername: string,
    configuredDomain: string,
    severities: VulnerabilitySeverity[] = [],
  ): Promise<HostingerVulnerabilityList> {
    const domain = normalizeDomain(configuredDomain);
    const parameters = new URLSearchParams();
    for (const severity of severities) {
      parameters.append("severities", severity);
    }
    const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
    const response = await this.request(
      "GET",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(
        domain,
      )}/nodejs/vulnerabilities${query}`,
    );
    const parsed = hostingerVulnerabilityCollectionSchema.safeParse(
      response.payload,
    );
    if (!parsed.success) throw malformedResponse(response.correlationId);
    return {
      vulnerabilities: parsed.data.map((item) => ({
        id: item.vulnerability_id,
        packageName: item.package_name,
        installedVersion: item.installed_version,
        severity: item.severity,
        cvssScore: item.cvss_score ?? undefined,
        cve: item.cve ?? undefined,
        isDirect: item.is_direct,
        isPatchable: item.is_patchable,
        fixVersion: item.fix_version ?? undefined,
        isPatchingInProgress: item.is_patching_in_progress,
        publishedAt: item.published_at ?? undefined,
        advisoryUrl: item.url
          ? validateAdvisoryLink(item.url)
          : undefined,
      })),
      correlationId: response.correlationId,
    };
  }

  async patchNodeVulnerabilities(
    configuredUsername: string,
    configuredDomain: string,
    vulnerabilityIds: string[],
  ): Promise<HostingerVulnerabilityPatchResult> {
    const ids = z
      .array(vulnerabilityIdSchema)
      .min(1)
      .max(1_000)
      .parse(vulnerabilityIds);
    const domain = normalizeDomain(configuredDomain);
    const response = await this.request(
      "POST",
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(
        domain,
      )}/nodejs/vulnerabilities/patch`,
      { vulnerability_ids: ids },
    );
    const parsed = hostingerPatchResultSchema.safeParse(response.payload);
    if (!parsed.success) throw malformedResponse(response.correlationId);
    const pullRequestUrl = parsed.data.pr_url
      ? validateGithubPullRequestLink(parsed.data.pr_url)
      : undefined;
    if (
      pullRequestUrl &&
      parsed.data.pr_number !== undefined &&
      Number(
        new URL(pullRequestUrl).pathname.match(
          /\/pull\/(\d+)\/?$/,
        )?.[1],
      ) !== parsed.data.pr_number
    ) {
      throw malformedResponse(response.correlationId);
    }
    return {
      accepted: true,
      patchedVulnerabilityIds: parsed.data.patched_vulnerability_ids,
      pullRequestUrl,
      pullRequestNumber: parsed.data.pr_number,
      headBranch: parsed.data.head_branch,
      correlationId: response.correlationId,
    };
  }

  private async databaseMutation(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<HostingerMutationResult> {
    const response = await this.request(method, path, body);
    if (
      response.payload !== null &&
      !hostingerEmptySuccessSchema.safeParse(response.payload).success
    ) {
      throw malformedResponse(response.correlationId);
    }
    return {
      accepted: true,
      correlationId: response.correlationId,
    };
  }

  private async siteMutation(
    method: "PATCH" | "DELETE",
    configuredUsername: string,
    configuredDomain: string,
    suffix: string,
    body?: Record<string, unknown>,
  ): Promise<HostingerMutationResult> {
    const domain = normalizeDomain(configuredDomain);
    const response = await this.request(
      method,
      `/api/hosting/v1/accounts/${encodeURIComponent(
        configuredUsername,
      )}/websites/${encodeURIComponent(domain)}${suffix}`,
      body,
    );
    if (
      response.payload !== null &&
      !hostingerEmptySuccessSchema.safeParse(response.payload).success
    ) {
      throw malformedResponse(response.correlationId);
    }
    return {
      accepted: true,
      correlationId: response.correlationId,
    };
  }
}

function databasePath(
  configuredUsername: string,
  databaseName: string,
  suffix = "",
) {
  return `/api/hosting/v1/accounts/${encodeURIComponent(
    configuredUsername,
  )}/databases/${encodeURIComponent(databaseName)}${suffix}`;
}

function isExactUnprocessableHostingerError(
  error: unknown,
): error is AppError {
  return (
    error instanceof AppError &&
    error.code === "HOSTINGER_ERROR" &&
    error.status === 422
  );
}

function diagnosticStatus(error: unknown) {
  return error instanceof AppError ? error.status : 502;
}

function diagnosticCorrelationId(error: unknown) {
  return error instanceof AppError ? error.correlationId : undefined;
}

function controlledDatabaseReadError(
  error: unknown,
  referenceId: string,
) {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.message,
      error.status,
      error.correlationId,
      referenceId,
      error.retryAfterSeconds,
    );
  }
  return new AppError(
    "HOSTINGER_ERROR",
    "Hostinger database data is temporarily unavailable.",
    503,
    undefined,
    referenceId,
  );
}

export function validateAdvisoryLink(value: string) {
  return validateExternalHttpsLink(value);
}

export function validateGithubPullRequestLink(value: string) {
  const normalized = validateExternalHttpsLink(
    value,
    new Set(["github.com", "www.github.com"]),
  );
  const link = new URL(normalized);
  if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(link.pathname)) {
    throw malformedResponse();
  }
  return link.toString();
}

function validateExternalHttpsLink(
  value: string,
  allowedHosts?: Set<string>,
) {
  let link: URL;
  try {
    link = new URL(value);
  } catch {
    throw malformedResponse();
  }
  if (
    link.protocol !== "https:" ||
    Boolean(link.username) ||
    Boolean(link.password) ||
    (link.port !== "" && link.port !== "443") ||
    (allowedHosts !== undefined &&
      !allowedHosts.has(link.hostname.toLowerCase())) ||
    Boolean(link.hash)
  ) {
    throw malformedResponse();
  }
  return link.toString();
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
