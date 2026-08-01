import "server-only";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import {
  AppError,
  type DiagnosticCode,
} from "@/lib/errors";

const MAX_PHPMYADMIN_LINK_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const phpMyAdminFailureKinds = [
  "response_shape",
  "missing_link",
  "ambiguous_link",
  "invalid_protocol",
  "credentials_present",
  "invalid_port",
  "fragment_present",
  "malformed_url",
  "invalid_public_hostname",
  "ip_literal",
  "local_hostname",
  "blocked_suffix",
  "invalid_dns_syntax",
  "configured_host_not_allowed",
  "upstream_http",
  "live_verification",
] as const;

export type PhpMyAdminFailureKind =
  (typeof phpMyAdminFailureKinds)[number];

export const phpMyAdminResponseShapes = [
  "direct",
  "data_wrapper",
] as const;

export type PhpMyAdminResponseShape =
  (typeof phpMyAdminResponseShapes)[number];

export const phpMyAdminDiagnosticResponseShapes = [
  ...phpMyAdminResponseShapes,
  "unknown",
] as const;

export type PhpMyAdminDiagnosticResponseShape =
  (typeof phpMyAdminDiagnosticResponseShapes)[number];

export const phpMyAdminPayloadKinds = [
  "object",
  "array",
  "string",
  "null",
  "other",
] as const;

export type PhpMyAdminPayloadKind =
  (typeof phpMyAdminPayloadKinds)[number];

export type PhpMyAdminPayloadStructure = {
  payloadKind: PhpMyAdminPayloadKind;
  hasDirectLink: boolean;
  hasData: boolean;
  dataKind: PhpMyAdminPayloadKind;
  hasWrappedLink: boolean;
  responseShape: PhpMyAdminDiagnosticResponseShape;
};

const diagnosticCodeByFailureKind = {
  response_shape: "PHPMYADMIN_RESPONSE_SHAPE",
  missing_link: "PHPMYADMIN_MISSING_LINK",
  ambiguous_link: "PHPMYADMIN_AMBIGUOUS_LINK",
  invalid_protocol: "PHPMYADMIN_INVALID_PROTOCOL",
  credentials_present: "PHPMYADMIN_URL_CREDENTIALS",
  invalid_port: "PHPMYADMIN_INVALID_PORT",
  fragment_present: "PHPMYADMIN_FRAGMENT",
  malformed_url: "PHPMYADMIN_MALFORMED_URL",
  invalid_public_hostname: "PHPMYADMIN_INVALID_PUBLIC_HOSTNAME",
  ip_literal: "PHPMYADMIN_IP_LITERAL",
  local_hostname: "PHPMYADMIN_LOCAL_HOSTNAME",
  blocked_suffix: "PHPMYADMIN_BLOCKED_SUFFIX",
  invalid_dns_syntax: "PHPMYADMIN_INVALID_DNS_SYNTAX",
  configured_host_not_allowed:
    "PHPMYADMIN_CONFIGURED_HOST_NOT_ALLOWED",
  upstream_http: "PHPMYADMIN_UPSTREAM",
  live_verification: "PHPMYADMIN_LIVE_VERIFICATION",
} satisfies Record<PhpMyAdminFailureKind, DiagnosticCode>;

const BLOCKED_PUBLIC_HOST_SUFFIXES = [
  "local",
  "localhost",
  "internal",
  "test",
  "invalid",
  "example",
] as const;

type AuthenticatedPhpMyAdminLinkOptions = {
  correlationId?: string;
  responseShape?: PhpMyAdminResponseShape;
  allowedHostSuffixes?: readonly string[];
};

export function phpMyAdminDiagnosticCode(
  failureKind: PhpMyAdminFailureKind,
) {
  return diagnosticCodeByFailureKind[failureKind];
}

export class PhpMyAdminLinkError extends AppError {
  constructor(
    public readonly failureKind: PhpMyAdminFailureKind,
    correlationId?: string,
    public readonly responseShape?: PhpMyAdminDiagnosticResponseShape,
    public readonly payloadStructure?: PhpMyAdminPayloadStructure,
  ) {
    super(
      "HOSTINGER_ERROR",
      "Hostinger returned an invalid phpMyAdmin link response.",
      502,
      correlationId,
      undefined,
      undefined,
      phpMyAdminDiagnosticCode(failureKind),
    );
    this.name = "PhpMyAdminLinkError";
  }
}

export function decodePhpMyAdminLink(
  payload: unknown,
  correlationId?: string,
) {
  const structure = describePhpMyAdminPayload(payload);
  if (!isRecord(payload)) {
    throw new PhpMyAdminLinkError(
      payload === null ? "missing_link" : "response_shape",
      correlationId,
      structure.responseShape,
      structure,
    );
  }

  const hasDirect = Object.hasOwn(payload, "link");
  const data = Object.hasOwn(payload, "data") ? payload.data : undefined;
  const hasWrapped =
    isRecord(data) && Object.hasOwn(data, "link");

  const directLink = hasDirect
    ? readLink(payload.link, correlationId, structure)
    : undefined;
  const wrappedLink = hasWrapped
    ? readLink(data.link, correlationId, structure)
    : undefined;

  if (
    directLink !== undefined &&
    wrappedLink !== undefined &&
    directLink !== wrappedLink
  ) {
    throw new PhpMyAdminLinkError(
      "ambiguous_link",
      correlationId,
      "unknown",
      { ...structure, responseShape: "unknown" },
    );
  }
  if (directLink !== undefined) {
    return {
      link: directLink,
      responseShape: "direct" as const,
    };
  }
  if (wrappedLink !== undefined) {
    return {
      link: wrappedLink,
      responseShape: "data_wrapper" as const,
    };
  }
  if (
    Object.hasOwn(payload, "data") &&
    data !== undefined &&
    !isRecord(data)
  ) {
    throw new PhpMyAdminLinkError(
      "response_shape",
      correlationId,
      structure.responseShape,
      structure,
    );
  }
  throw new PhpMyAdminLinkError(
    "missing_link",
    correlationId,
    structure.responseShape,
    structure,
  );
}

/**
 * Validates only a link obtained from the authenticated, database-specific
 * Hostinger phpMyAdmin endpoint. This is deliberately server-only and is not
 * a general-purpose redirect validator.
 */
export function validateAuthenticatedPhpMyAdminLink(
  value: string,
  options: AuthenticatedPhpMyAdminLinkOptions = {},
) {
  const { correlationId, responseShape, allowedHostSuffixes } =
    options;
  if (
    value.length === 0 ||
    value.length > MAX_PHPMYADMIN_LINK_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new PhpMyAdminLinkError(
      "malformed_url",
      correlationId,
      responseShape,
    );
  }

  let link: URL;
  try {
    link = new URL(value);
  } catch {
    throw new PhpMyAdminLinkError(
      "malformed_url",
      correlationId,
      responseShape,
    );
  }

  if (link.protocol !== "https:") {
    throw new PhpMyAdminLinkError(
      "invalid_protocol",
      correlationId,
      responseShape,
    );
  }
  if (link.username || link.password) {
    throw new PhpMyAdminLinkError(
      "credentials_present",
      correlationId,
      responseShape,
    );
  }
  if (link.port !== "" && link.port !== "443") {
    throw new PhpMyAdminLinkError(
      "invalid_port",
      correlationId,
      responseShape,
    );
  }

  const hostname = normalizePublicDnsHostname(
    link.hostname,
    correlationId,
    responseShape,
  );
  if (
    allowedHostSuffixes !== undefined &&
    !allowedHostSuffixes.some((suffix) =>
      hostnameMatchesSuffix(hostname, suffix),
    )
  ) {
    throw new PhpMyAdminLinkError(
      "configured_host_not_allowed",
      correlationId,
      responseShape,
    );
  }
  if (link.hash) {
    throw new PhpMyAdminLinkError(
      "fragment_present",
      correlationId,
      responseShape,
    );
  }
  return link.toString();
}

export function parsePhpMyAdminAllowedHostSuffixes(
  value: string | undefined,
) {
  if (value === undefined) return undefined;
  const entries = value.split(",");
  if (entries.length === 0 || entries.some((entry) => !entry.trim())) {
    throw new Error("Invalid phpMyAdmin host suffix configuration.");
  }
  const normalized = entries.map((entry) => {
    const candidate = entry.trim();
    if (
      /[^\u0000-\u007f]/.test(candidate) ||
      candidate !== candidate.toLowerCase() ||
      candidate.includes("://") ||
      /[/*:@?#\[\]\\]/.test(candidate)
    ) {
      throw new Error("Invalid phpMyAdmin host suffix configuration.");
    }
    try {
      return normalizePublicDnsHostname(candidate);
    } catch {
      throw new Error("Invalid phpMyAdmin host suffix configuration.");
    }
  });
  return [...new Set(normalized)];
}

function normalizePublicDnsHostname(
  value: string,
  correlationId?: string,
  responseShape?: PhpMyAdminResponseShape,
) {
  const ipCandidate = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  if (isIP(ipCandidate) !== 0) {
    throw new PhpMyAdminLinkError(
      "ip_literal",
      correlationId,
      responseShape,
    );
  }

  const ascii = domainToASCII(value).toLowerCase();
  if (!ascii || /[^\x00-\x7f]/.test(ascii)) {
    throw new PhpMyAdminLinkError(
      "invalid_dns_syntax",
      correlationId,
      responseShape,
    );
  }
  if (
    ascii === "localhost" ||
    ascii.endsWith(".localhost")
  ) {
    throw new PhpMyAdminLinkError(
      "local_hostname",
      correlationId,
      responseShape,
    );
  }

  const labels = ascii.split(".");
  if (labels.length < 2) {
    throw new PhpMyAdminLinkError(
      "invalid_public_hostname",
      correlationId,
      responseShape,
    );
  }
  if (
    ascii.length > 253 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new PhpMyAdminLinkError(
      "invalid_dns_syntax",
      correlationId,
      responseShape,
    );
  }
  if (
    BLOCKED_PUBLIC_HOST_SUFFIXES.some(
      (suffix) =>
        ascii === suffix || ascii.endsWith(`.${suffix}`),
    )
  ) {
    throw new PhpMyAdminLinkError(
      "blocked_suffix",
      correlationId,
      responseShape,
    );
  }
  return ascii;
}

function hostnameMatchesSuffix(hostname: string, suffix: string) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function describePhpMyAdminPayload(
  payload: unknown,
): PhpMyAdminPayloadStructure {
  const payloadKind = payloadKindOf(payload);
  const hasDirectLink =
    isRecord(payload) && Object.hasOwn(payload, "link");
  const hasData =
    isRecord(payload) && Object.hasOwn(payload, "data");
  const data = hasData && isRecord(payload) ? payload.data : undefined;
  const dataKind = hasData ? payloadKindOf(data) : "other";
  const hasWrappedLink =
    isRecord(data) && Object.hasOwn(data, "link");
  const responseShape =
    hasDirectLink && !hasWrappedLink
      ? "direct"
      : !hasDirectLink && hasWrappedLink
        ? "data_wrapper"
        : "unknown";
  return {
    payloadKind,
    hasDirectLink,
    hasData,
    dataKind,
    hasWrappedLink,
    responseShape,
  };
}

function readLink(
  value: unknown,
  correlationId: string | undefined,
  structure: PhpMyAdminPayloadStructure,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PHPMYADMIN_LINK_LENGTH
  ) {
    throw new PhpMyAdminLinkError(
      "response_shape",
      correlationId,
      structure.responseShape,
      structure,
    );
  }
  return value;
}

function payloadKindOf(value: unknown): PhpMyAdminPayloadKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "object") return "object";
  return "other";
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
