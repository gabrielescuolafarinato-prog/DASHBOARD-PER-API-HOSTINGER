import "server-only";
import { randomBytes } from "node:crypto";
import {
  phpMyAdminDiagnosticResponseShapes,
  phpMyAdminFailureKinds,
  phpMyAdminPayloadKinds,
  type PhpMyAdminFailureKind,
  type PhpMyAdminDiagnosticResponseShape,
  type PhpMyAdminPayloadKind,
  type PhpMyAdminPayloadStructure,
} from "./phpmyadmin-link";
import { emitStructuredDiagnostic } from "./structured-diagnostic";

export const hostingerDiagnosticPhases = [
  "database_create",
  "database_change_password",
  "database_repair",
  "database_delete",
  "database_phpmyadmin",
  "database_remote_add",
  "database_remote_remove",
  "database_live_verification",
  "cache_clear",
  "cache_toggle",
  "cacheless_toggle",
  "vulnerability_list",
  "vulnerability_patch",
  "dns_records_list",
  "dns_records_create",
  "dns_records_update",
  "dns_records_delete",
  "dns_snapshots_list",
  "dns_snapshots_view",
  "subdomains_list",
  "subdomains_create",
  "subdomains_delete",
  "aliases_list",
  "aliases_create",
  "aliases_delete",
] as const;

export type HostingerDiagnosticPhase =
  (typeof hostingerDiagnosticPhases)[number];

export type HostingerOperationDiagnostic = {
  referenceId: string;
  phase: HostingerDiagnosticPhase;
  upstreamStatus: number;
  correlationId?: string;
  operationType: string;
  idempotencyStatus:
    | "not_applicable"
    | "claimed"
    | "duplicate"
    | "blocked"
    | "completed"
    | "failed";
  result: "success" | "failure" | "denied" | "accepted" | "recovered";
  durationBucket: "<250ms" | "<1s" | "<3s" | "<10s" | ">=10s";
  failureKind?: PhpMyAdminFailureKind;
  responseShape?: PhpMyAdminDiagnosticResponseShape;
  payloadKind?: PhpMyAdminPayloadKind;
  hasDirectLink?: boolean;
  hasData?: boolean;
  dataKind?: PhpMyAdminPayloadKind;
  hasWrappedLink?: boolean;
  resourceCategory?: "dns_zone" | "dns_snapshot" | "subdomain" | "domain_alias";
  dnsRecordType?:
    | "A"
    | "AAAA"
    | "CNAME"
    | "ALIAS"
    | "MX"
    | "TXT"
    | "NS"
    | "SOA"
    | "SRV"
    | "CAA";
};

export function createDiagnosticReferenceId() {
  return randomBytes(6).toString("hex");
}

export function reportHostingerOperationDiagnostic(input: {
  referenceId?: string;
  phase: HostingerDiagnosticPhase;
  upstreamStatus?: number;
  correlationId?: unknown;
  operationType: string;
  idempotencyStatus: HostingerOperationDiagnostic["idempotencyStatus"];
  result: HostingerOperationDiagnostic["result"];
  startedAt?: number;
  forbiddenValues?: unknown[];
  failureKind?: PhpMyAdminFailureKind;
  responseShape?: PhpMyAdminDiagnosticResponseShape;
  payloadStructure?: PhpMyAdminPayloadStructure;
  resourceCategory?: HostingerOperationDiagnostic["resourceCategory"];
  dnsRecordType?: HostingerOperationDiagnostic["dnsRecordType"];
}) {
  let referenceId = "000000000000";
  let fallbackDiagnostic: HostingerOperationDiagnostic = {
    referenceId,
    phase: "database_phpmyadmin",
    upstreamStatus: 502,
    operationType: "database.phpmyadmin.link",
    idempotencyStatus: "not_applicable",
    result: "failure",
    durationBucket: "<250ms",
  };
  try {
    referenceId = safeReferenceId(input.referenceId);
    fallbackDiagnostic = {
      referenceId,
      phase: input.phase,
      upstreamStatus: safeStatus(input.upstreamStatus),
      operationType: safeOperationType(input.operationType),
      idempotencyStatus: input.idempotencyStatus,
      result: input.result,
      durationBucket: durationBucket(input.startedAt),
    };
    const diagnostic = { ...fallbackDiagnostic };
    let correlationId: string | undefined;
    try {
      correlationId = sanitizeCorrelationId(
        input.correlationId,
        input.forbiddenValues,
      );
    } catch {
      correlationId = undefined;
    }
    if (correlationId) diagnostic.correlationId = correlationId;
    if (
      input.failureKind &&
      phpMyAdminFailureKinds.includes(input.failureKind)
    ) {
      diagnostic.failureKind = input.failureKind;
    }
    if (
      input.responseShape &&
      phpMyAdminDiagnosticResponseShapes.includes(input.responseShape)
    ) {
      diagnostic.responseShape = input.responseShape;
    }
    appendPayloadStructure(diagnostic, input.payloadStructure);
    if (input.resourceCategory) {
      diagnostic.resourceCategory = input.resourceCategory;
    }
    if (input.dnsRecordType) {
      diagnostic.dnsRecordType = input.dnsRecordType;
    }
    emitStructuredDiagnostic(
      operationDiagnosticLevel(diagnostic),
      "hostinger_operation_diagnostic",
      diagnostic,
    );
  } catch {
    emitStructuredDiagnostic(
      "error",
      "hostinger_operation_diagnostic",
      fallbackDiagnostic,
    );
  }
  return referenceId;
}

function operationDiagnosticLevel(
  diagnostic: HostingerOperationDiagnostic,
) {
  if (diagnostic.result === "recovered") return "warn" as const;
  return diagnostic.upstreamStatus < 400 &&
    (diagnostic.result === "success" ||
      diagnostic.result === "accepted")
    ? ("info" as const)
    : ("error" as const);
}

function safeReferenceId(value?: string) {
  if (typeof value === "string" && /^[a-f0-9]{12}$/.test(value)) {
    return value;
  }
  try {
    return createDiagnosticReferenceId();
  } catch {
    return "000000000000";
  }
}

function appendPayloadStructure(
  diagnostic: HostingerOperationDiagnostic,
  structure?: PhpMyAdminPayloadStructure,
) {
  if (!structure) return;
  if (
    !phpMyAdminPayloadKinds.includes(structure.payloadKind) ||
    !phpMyAdminPayloadKinds.includes(structure.dataKind) ||
    !phpMyAdminDiagnosticResponseShapes.includes(
      structure.responseShape,
    ) ||
    typeof structure.hasDirectLink !== "boolean" ||
    typeof structure.hasData !== "boolean" ||
    typeof structure.hasWrappedLink !== "boolean"
  ) {
    return;
  }
  diagnostic.payloadKind = structure.payloadKind;
  diagnostic.hasDirectLink = structure.hasDirectLink;
  diagnostic.hasData = structure.hasData;
  diagnostic.dataKind = structure.dataKind;
  diagnostic.hasWrappedLink = structure.hasWrappedLink;
  diagnostic.responseShape = structure.responseShape;
}

function safeStatus(value?: number) {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : 502;
}

function safeOperationType(value: string) {
  return /^[a-z][a-z0-9._-]{0,99}$/.test(value)
    ? value
    : "unknown";
}

function sanitizeCorrelationId(
  value: unknown,
  forbiddenValues?: unknown[],
) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
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

function durationBucket(startedAt?: number) {
  const elapsed =
    startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
  if (elapsed < 250) return "<250ms";
  if (elapsed < 1_000) return "<1s";
  if (elapsed < 3_000) return "<3s";
  if (elapsed < 10_000) return "<10s";
  return ">=10s";
}
