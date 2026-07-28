import "server-only";
import { randomBytes } from "node:crypto";
import type { ZodError, ZodIssue } from "zod";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_DIAGNOSTIC_ITEMS_TO_INSPECT = 100;

const ZOD_CODE_ALLOWLIST = new Set([
  "custom",
  "invalid_format",
  "invalid_type",
  "invalid_union",
  "invalid_value",
  "too_big",
  "too_small",
]);

const ZOD_PATH_ALLOWLIST = new Set([
  "root",
  "data",
  "data.*",
  "data.*.uuid",
  "data.*.state",
  "data.*.options",
  "meta",
  "meta.current_page",
  "meta.per_page",
  "meta.total",
]);

const EXPECTED_FIELD_ORDER = [
  "data",
  "meta",
  "uuid",
  "state",
  "current_page",
  "per_page",
  "total",
] as const;

export type BuildResponseDiagnostic = {
  referenceId: string;
  phase: "build_list_decode";
  correlationId?: string;
  category:
    | "duplicate_identifier"
    | "invalid_core_field"
    | "invalid_pagination"
    | "invalid_structure"
    | "missing_required_fields";
  itemCount?: number;
  missingFields: string[];
  zodPaths: string[];
  zodCodes: string[];
};

export function reportBuildResponseDiagnostic(
  payload: unknown,
  error: ZodError,
  correlationId?: string,
) {
  const referenceId = randomBytes(6).toString("hex");
  const missingFields = findMissingFields(payload);
  const zodPaths = unique(
    error.issues
      .map((issue) => allowlistedPath(issue))
      .filter((path): path is string => path !== undefined),
  );
  const zodCodes = unique(
    error.issues
      .map((issue) => issue.code)
      .filter((code) => ZOD_CODE_ALLOWLIST.has(code)),
  );
  const itemCount = getItemCount(payload);
  const safeCorrelationId = sanitizeCorrelationId(correlationId);
  const diagnostic: BuildResponseDiagnostic = {
    referenceId,
    phase: "build_list_decode",
    ...(safeCorrelationId ? { correlationId: safeCorrelationId } : {}),
    category: categorize(missingFields, zodPaths, zodCodes),
    ...(itemCount === undefined ? {} : { itemCount }),
    missingFields,
    zodPaths,
    zodCodes,
  };

  console.error("hostinger_build_response_diagnostic", diagnostic);
  return referenceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findMissingFields(payload: unknown) {
  const missing = new Set<(typeof EXPECTED_FIELD_ORDER)[number]>();
  if (!isRecord(payload)) {
    missing.add("data");
    missing.add("meta");
    return orderedFields(missing);
  }

  if (!Object.hasOwn(payload, "data")) {
    missing.add("data");
  } else if (Array.isArray(payload.data)) {
    for (const item of payload.data.slice(0, MAX_DIAGNOSTIC_ITEMS_TO_INSPECT)) {
      if (!isRecord(item)) {
        missing.add("uuid");
        missing.add("state");
        continue;
      }
      if (!Object.hasOwn(item, "uuid")) missing.add("uuid");
      if (!Object.hasOwn(item, "state")) missing.add("state");
    }
  }

  if (!Object.hasOwn(payload, "meta")) {
    missing.add("meta");
  } else if (isRecord(payload.meta)) {
    if (!Object.hasOwn(payload.meta, "current_page")) {
      missing.add("current_page");
    }
    if (!Object.hasOwn(payload.meta, "per_page")) {
      missing.add("per_page");
    }
    if (!Object.hasOwn(payload.meta, "total")) missing.add("total");
  }

  return orderedFields(missing);
}

function orderedFields(
  fields: Set<(typeof EXPECTED_FIELD_ORDER)[number]>,
) {
  return EXPECTED_FIELD_ORDER.filter((field) => fields.has(field));
}

function getItemCount(payload: unknown) {
  return isRecord(payload) && Array.isArray(payload.data)
    ? payload.data.length
    : undefined;
}

function allowlistedPath(issue: ZodIssue) {
  const normalized =
    issue.path.length === 0
      ? "root"
      : issue.path
          .map((segment) => (typeof segment === "number" ? "*" : segment))
          .join(".");
  return ZOD_PATH_ALLOWLIST.has(normalized) ? normalized : undefined;
}

function categorize(
  missingFields: string[],
  paths: string[],
  codes: string[],
): BuildResponseDiagnostic["category"] {
  if (missingFields.length > 0) return "missing_required_fields";
  if (codes.includes("custom") && paths.includes("data.*.uuid")) {
    return "duplicate_identifier";
  }
  if (
    paths.some(
      (path) => path === "data.*.uuid" || path === "data.*.state",
    )
  ) {
    return "invalid_core_field";
  }
  if (paths.some((path) => path === "meta" || path.startsWith("meta."))) {
    return "invalid_pagination";
  }
  return "invalid_structure";
}

function sanitizeCorrelationId(value: unknown) {
  return typeof value === "string" &&
    CORRELATION_ID_PATTERN.test(value) &&
    !value.includes("://")
    ? value
    : undefined;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
