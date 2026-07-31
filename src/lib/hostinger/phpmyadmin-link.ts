import { AppError } from "@/lib/errors";

const MAX_PHPMYADMIN_LINK_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CREDENTIAL_QUERY_KEY_PATTERN =
  /(?:^|[_-])(?:user(?:name)?|password|pass|pwd)(?:$|[_-])/i;

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

export class PhpMyAdminLinkError extends AppError {
  constructor(
    public readonly failureKind: PhpMyAdminFailureKind,
    correlationId?: string,
    public readonly responseShape?: PhpMyAdminResponseShape,
  ) {
    super(
      "HOSTINGER_ERROR",
      "Hostinger returned an invalid phpMyAdmin link response.",
      502,
      correlationId,
    );
    this.name = "PhpMyAdminLinkError";
  }
}

export function decodePhpMyAdminLink(
  payload: unknown,
  correlationId?: string,
) {
  if (!isRecord(payload)) {
    throw new PhpMyAdminLinkError(
      payload === null ? "missing_link" : "response_shape",
      correlationId,
    );
  }

  const hasDirect = Object.hasOwn(payload, "link");
  const data = Object.hasOwn(payload, "data") ? payload.data : undefined;
  const hasWrapped =
    isRecord(data) && Object.hasOwn(data, "link");

  const directLink = hasDirect
    ? readLink(payload.link, correlationId)
    : undefined;
  const wrappedLink = hasWrapped
    ? readLink(data.link, correlationId)
    : undefined;

  if (
    directLink !== undefined &&
    wrappedLink !== undefined &&
    directLink !== wrappedLink
  ) {
    throw new PhpMyAdminLinkError(
      "ambiguous_link",
      correlationId,
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
    );
  }
  throw new PhpMyAdminLinkError("missing_link", correlationId);
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
  if (
    [...link.searchParams.keys()].some((key) =>
      CREDENTIAL_QUERY_KEY_PATTERN.test(key),
    )
  ) {
    throw new PhpMyAdminLinkError(
      "credentials_present",
      correlationId,
      responseShape,
    );
  }
  return link.toString();
}

function readLink(value: unknown, correlationId?: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PHPMYADMIN_LINK_LENGTH
  ) {
    throw new PhpMyAdminLinkError(
      "response_shape",
      correlationId,
    );
  }
  return value;
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
