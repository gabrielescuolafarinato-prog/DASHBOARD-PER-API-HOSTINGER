import "server-only";
import { randomBytes } from "node:crypto";

const REFERENCE_ID_PATTERN = /^[a-f0-9]{12}$/;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const VALIDATION_FIELD_ALLOWLIST = new Set([
  "page",
  "per_page",
  "domain",
  "is_assigned",
  "search",
]);

export type DatabaseRequestDiagnosticPhase =
  | "database_list_filtered"
  | "database_list_fallback"
  | "remote_list_filtered"
  | "remote_list_fallback";

export type DatabaseRequestDiagnostic = {
  referenceId: string;
  phase: DatabaseRequestDiagnosticPhase;
  upstreamStatus: number;
  correlationId?: string;
  endpointKind: "database_list" | "remote_connection_list";
  attempt: "filtered" | "fallback";
  validationFields?: string[];
  result: "retry" | "success" | "failure";
};

export function reportDatabaseRequestDiagnostic(input: {
  referenceId?: string;
  phase: DatabaseRequestDiagnosticPhase;
  upstreamStatus: number;
  correlationId?: unknown;
  endpointKind: DatabaseRequestDiagnostic["endpointKind"];
  attempt: DatabaseRequestDiagnostic["attempt"];
  forbiddenValues?: unknown[];
  validationFields?: unknown[];
  result: DatabaseRequestDiagnostic["result"];
}) {
  const referenceId =
    typeof input.referenceId === "string" &&
    REFERENCE_ID_PATTERN.test(input.referenceId)
      ? input.referenceId
      : randomBytes(6).toString("hex");
  const correlationId = sanitizeCorrelationId(
    input.correlationId,
    input.forbiddenValues,
  );
  const validationFields = sanitizeValidationFields(
    input.validationFields,
  );
  const diagnostic: DatabaseRequestDiagnostic = {
    referenceId,
    phase: input.phase,
    upstreamStatus: safeStatus(input.upstreamStatus),
    ...(correlationId ? { correlationId } : {}),
    endpointKind: input.endpointKind,
    attempt: input.attempt,
    ...(validationFields.length > 0 ? { validationFields } : {}),
    result: input.result,
  };

  console.error("hostinger_database_request_diagnostic", diagnostic);
  return referenceId;
}

function sanitizeCorrelationId(
  value: unknown,
  forbiddenValues?: unknown[],
) {
  if (
    typeof value !== "string" ||
    !CORRELATION_ID_PATTERN.test(value) ||
    value.includes("://")
  ) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const forbidden = (forbiddenValues ?? []).filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  return forbidden.some((candidate) =>
    normalized.includes(candidate.toLowerCase()),
  )
    ? undefined
    : value;
}

function sanitizeValidationFields(values?: unknown[]) {
  if (!values) return [];
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" &&
          VALIDATION_FIELD_ALLOWLIST.has(value),
      ),
    ),
  ];
}

function safeStatus(value: number) {
  return Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : 502;
}
