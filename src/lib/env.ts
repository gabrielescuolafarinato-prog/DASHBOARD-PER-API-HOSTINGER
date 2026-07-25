import { z } from "zod";

export type EnvironmentSource = Record<string, string | undefined>;

export const MIGRATION_DATABASE_URL_NAMES = [
  "DATABASE_MIGRATION_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL",
] as const;

export class ServerEnvironmentError extends Error {
  readonly code = "SERVER_ENVIRONMENT_INVALID";

  constructor(details: string) {
    super(`Invalid server environment: ${details}`);
    this.name = "ServerEnvironmentError";
  }
}

const databaseInputSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "must be a PostgreSQL connection URL",
    ),
});

const authInputSchema = z.object({
  AUTH_SECRET: z
    .string()
    .min(32, "must contain at least 32 characters")
    .refine(
      (value) =>
        !value.toLowerCase().includes("replace-with") &&
        new Set(value).size >= 12,
      "must be a high-entropy value, not a placeholder",
    ),
  APP_URL: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  VERCEL_URL: z.string().optional(),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
});

const hostingerSchema = z
  .object({
    HOSTINGER_API_TOKEN: z.string().min(1).optional(),
    HOSTINGER_ACCOUNT_USERNAME: z.string().min(1).optional(),
    HOSTINGER_SITE_DOMAIN: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    const count = Object.values(value).filter(Boolean).length;
    if (count !== 0 && count !== 3) {
      context.addIssue({
        code: "custom",
        message:
          "HOSTINGER_API_TOKEN, HOSTINGER_ACCOUNT_USERNAME and HOSTINGER_SITE_DOMAIN must be configured together",
      });
    }
  });

function formatError(error: z.ZodError): ServerEnvironmentError {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
  return new ServerEnvironmentError(details);
}

function normalizeConfiguredOrigin(value: string, production: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerEnvironmentError("APP_URL must be a complete valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ServerEnvironmentError("APP_URL must use HTTP or HTTPS.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ServerEnvironmentError(
      "APP_URL must be an origin without credentials, path, query, or hash.",
    );
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (production && url.protocol !== "https:") {
    throw new ServerEnvironmentError(
      "APP_URL must use HTTPS outside local development.",
    );
  }
  if (
    production &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1")
  ) {
    throw new ServerEnvironmentError(
      "Localhost cannot be an authorized production origin.",
    );
  }
  if (!production && url.hostname === "localhost" && url.protocol !== "http:") {
    throw new ServerEnvironmentError(
      "Localhost must use an explicitly configured HTTP origin.",
    );
  }
  if (!production && url.protocol === "http:" && url.hostname !== "localhost") {
    throw new ServerEnvironmentError(
      "HTTP APP_URL is permitted only for explicitly configured localhost development.",
    );
  }
  return url.origin;
}

const VERCEL_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/;

type VercelHostnameVariable =
  | "VERCEL_URL"
  | "VERCEL_BRANCH_URL"
  | "VERCEL_PROJECT_PRODUCTION_URL";

function normalizeVercelHostname(
  name: VercelHostnameVariable,
  value: string | undefined,
) {
  if (!value) return undefined;
  if (/\s/.test(value)) {
    throw new ServerEnvironmentError(
      `${name} must not contain whitespace.`,
    );
  }
  const hostname = value.toLowerCase().replace(/\.+$/, "");
  if (!VERCEL_HOSTNAME_PATTERN.test(hostname)) {
    throw new ServerEnvironmentError(
      `${name} must be an exact syntactically valid subdomain of vercel.app without a protocol, port, credentials, path, query, fragment, or wildcard.`,
    );
  }
  return hostname;
}

function authSource(source: EnvironmentSource) {
  return {
    AUTH_SECRET: source.AUTH_SECRET,
    APP_URL: source.APP_URL || undefined,
    NODE_ENV: source.NODE_ENV || undefined,
    VERCEL: source.VERCEL || undefined,
    VERCEL_ENV: source.VERCEL_ENV || undefined,
    VERCEL_URL: source.VERCEL_URL || undefined,
    VERCEL_BRANCH_URL: source.VERCEL_BRANCH_URL || undefined,
    VERCEL_PROJECT_PRODUCTION_URL:
      source.VERCEL_PROJECT_PRODUCTION_URL || undefined,
  };
}

export type AuthHostConfiguration = {
  configuredOrigin: string | undefined;
  allowedHosts: string[];
  trustedOrigins: string[];
};

export function getAllowedAuthHosts(
  source: EnvironmentSource,
  production = source.NODE_ENV === "production",
): AuthHostConfiguration {
  const origins = new Map<string, string>();
  let configuredOrigin: string | undefined;

  if (source.APP_URL) {
    configuredOrigin = normalizeConfiguredOrigin(source.APP_URL, production);
    origins.set(new URL(configuredOrigin).host, configuredOrigin);
  }

  if (source.VERCEL === "1") {
    const vercelHosts = [
      normalizeVercelHostname("VERCEL_URL", source.VERCEL_URL),
      normalizeVercelHostname("VERCEL_BRANCH_URL", source.VERCEL_BRANCH_URL),
      normalizeVercelHostname(
        "VERCEL_PROJECT_PRODUCTION_URL",
        source.VERCEL_PROJECT_PRODUCTION_URL,
      ),
    ];

    for (const hostname of vercelHosts) {
      if (hostname) origins.set(hostname, `https://${hostname}`);
    }

    const firstVercelHost = vercelHosts.find(
      (hostname): hostname is string => Boolean(hostname),
    );
    if (
      firstVercelHost &&
      configuredOrigin?.startsWith("http://localhost")
    ) {
      throw new ServerEnvironmentError(
        "A local HTTP APP_URL cannot be combined with HTTPS Vercel hosts.",
      );
    }
    configuredOrigin ??= firstVercelHost
      ? `https://${firstVercelHost}`
      : undefined;
  }

  return {
    configuredOrigin,
    allowedHosts: [...origins.keys()],
    trustedOrigins: [...origins.values()],
  };
}

export function parseDatabaseEnv(source: EnvironmentSource) {
  const result = databaseInputSchema.safeParse({
    DATABASE_URL: source.DATABASE_URL,
  });
  if (!result.success) throw formatError(result.error);
  return result.data;
}

export function parseMigrationEnv(source: EnvironmentSource) {
  for (const name of MIGRATION_DATABASE_URL_NAMES) {
    const connectionString = source[name]?.trim();
    if (!connectionString) continue;

    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new ServerEnvironmentError(
        `${name}: must be a PostgreSQL connection URL`,
      );
    }

    return { connectionString, source: name } as const;
  }

  throw new ServerEnvironmentError(
    `one of ${MIGRATION_DATABASE_URL_NAMES.join(", ")} is required for migrations`,
  );
}

export function parseAuthEnv(source: EnvironmentSource) {
  const result = authInputSchema.safeParse(authSource(source));
  if (!result.success) throw formatError(result.error);

  const production = result.data.NODE_ENV === "production";
  const hostConfiguration = getAllowedAuthHosts(result.data, production);

  if (
    !hostConfiguration.configuredOrigin ||
    hostConfiguration.allowedHosts.length === 0
  ) {
    throw new ServerEnvironmentError(
      "APP_URL is required unless an exact Vercel system hostname is available.",
    );
  }

  return {
    AUTH_SECRET: result.data.AUTH_SECRET,
    APP_URL: hostConfiguration.configuredOrigin,
    AUTH_ALLOWED_ORIGINS: hostConfiguration.trustedOrigins,
    AUTH_ALLOWED_HOSTS: hostConfiguration.allowedHosts,
    AUTH_BASE_URL_PROTOCOL: production
      ? ("https" as const)
      : hostConfiguration.configuredOrigin.startsWith("http://localhost")
        ? ("http" as const)
        : ("https" as const),
    IS_PRODUCTION: production,
  };
}

export function parseRuntimeEnv(source: EnvironmentSource) {
  return {
    ...parseDatabaseEnv(source),
    ...parseAuthEnv(source),
  };
}

// Kept as a compatibility alias for existing tests and external imports.
export const parseCoreEnv = parseRuntimeEnv;

export function parseHostingerEnv(source: EnvironmentSource) {
  const normalized = {
    HOSTINGER_API_TOKEN: source.HOSTINGER_API_TOKEN || undefined,
    HOSTINGER_ACCOUNT_USERNAME:
      source.HOSTINGER_ACCOUNT_USERNAME || undefined,
    HOSTINGER_SITE_DOMAIN: source.HOSTINGER_SITE_DOMAIN || undefined,
  };
  const result = hostingerSchema.safeParse(normalized);
  if (!result.success) throw formatError(result.error);
  return result.data;
}

export function getApplicationSetupStatus(
  source: EnvironmentSource = process.env,
) {
  const databaseConfigured = databaseInputSchema.safeParse({
    DATABASE_URL: source.DATABASE_URL,
  }).success;

  let authenticationConfigured = false;
  try {
    parseAuthEnv(source);
    authenticationConfigured = true;
  } catch {
    authenticationConfigured = false;
  }

  const hostinger = parseHostingerEnvSafely(source);
  const hostingerConfigured =
    hostinger.valid &&
    Boolean(
      hostinger.value?.HOSTINGER_API_TOKEN &&
        hostinger.value.HOSTINGER_ACCOUNT_USERNAME &&
        hostinger.value.HOSTINGER_SITE_DOMAIN,
    );

  return {
    applicationConfigured: databaseConfigured && authenticationConfigured,
    databaseConfigured,
    authenticationConfigured,
    hostingerConfigured,
  } as const;
}

function parseHostingerEnvSafely(source: EnvironmentSource) {
  try {
    return { valid: true as const, value: parseHostingerEnv(source) };
  } catch {
    return { valid: false as const, value: undefined };
  }
}

export function isAllowedAuthOrigin(
  candidate: string,
  allowedOrigins: readonly string[],
) {
  try {
    return allowedOrigins.includes(new URL(candidate).origin);
  } catch {
    return false;
  }
}

export const getRuntimeEnv = () => parseRuntimeEnv(process.env);
export const getDatabaseEnv = () => parseDatabaseEnv(process.env);
export const getAuthEnv = () => parseAuthEnv(process.env);
export const getHostingerEnv = () => parseHostingerEnv(process.env);

export type RuntimeEnv = ReturnType<typeof parseRuntimeEnv>;
export type AuthEnv = ReturnType<typeof parseAuthEnv>;
export type HostingerEnv = ReturnType<typeof parseHostingerEnv>;
