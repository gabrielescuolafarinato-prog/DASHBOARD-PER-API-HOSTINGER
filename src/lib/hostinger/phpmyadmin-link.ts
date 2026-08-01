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
  "invalid_host_boundary",
  "credentials_present",
  "invalid_port",
  "fragment_present",
  "malformed_url",
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
  invalid_host_boundary: "PHPMYADMIN_INVALID_HOST",
  credentials_present: "PHPMYADMIN_URL_CREDENTIALS",
  invalid_port: "PHPMYADMIN_INVALID_PORT",
  fragment_present: "PHPMYADMIN_FRAGMENT",
  malformed_url: "PHPMYADMIN_MALFORMED_URL",
  upstream_http: "PHPMYADMIN_UPSTREAM",
  live_verification: "PHPMYADMIN_LIVE_VERIFICATION",
} satisfies Record<PhpMyAdminFailureKind, DiagnosticCode>;

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

export function validatePhpMyAdminLink(
  value: string,
  correlationId?: string,
  responseShape?: PhpMyAdminResponseShape,
) {
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

  const hostname = link.hostname.toLowerCase();
  if (
    hostname === "hostinger.com" ||
    !hostname.endsWith(".hostinger.com")
  ) {
    throw new PhpMyAdminLinkError(
      "invalid_host_boundary",
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
