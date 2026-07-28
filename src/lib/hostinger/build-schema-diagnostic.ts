import "server-only";
import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/errors";

const MAX_ERROR_CAUSE_DEPTH = 4;
const BUILD_MIGRATION_SQLSTATES = new Set(["42P01", "42704"]);
const SAFE_ERROR_TYPES = new Set([
  "DatabaseError",
  "DrizzleError",
  "DrizzleQueryError",
  "Error",
  "NeonDbError",
  "PostgresError",
]);

type DatabaseSchemaDiagnostic = {
  referenceId: string;
  phase: "site_build_sync";
  sqlstate: "42P01" | "42704";
  errorType:
    | "DatabaseError"
    | "DrizzleError"
    | "DrizzleQueryError"
    | "Error"
    | "NeonDbError"
    | "PostgresError"
    | "UnknownError";
  expectedMigration: "0002";
  result: "failure";
};

export function buildMigrationRequiredError(error: unknown) {
  const match = findBuildMigrationError(error);
  if (!match) return undefined;

  const referenceId = randomBytes(6).toString("hex");
  const diagnostic: DatabaseSchemaDiagnostic = {
    referenceId,
    phase: "site_build_sync",
    sqlstate: match.sqlstate,
    errorType: match.errorType,
    expectedMigration: "0002",
    result: "failure",
  };
  console.error("database_schema_diagnostic", diagnostic);

  return new AppError(
    "DATABASE_MIGRATION_REQUIRED",
    "Database update required.",
    503,
    undefined,
    referenceId,
  );
}

function findBuildMigrationError(error: unknown) {
  for (const candidate of safeErrorCauseChain(error)) {
    const sqlstate = candidate.code;
    if (
      typeof sqlstate !== "string" ||
      !BUILD_MIGRATION_SQLSTATES.has(sqlstate)
    ) {
      continue;
    }
    if (!matchesExpectedBuildObject(candidate, sqlstate)) continue;
    return {
      sqlstate: sqlstate as DatabaseSchemaDiagnostic["sqlstate"],
      errorType: safeErrorType(candidate),
    };
  }
}

function matchesExpectedBuildObject(
  candidate: Record<string, unknown>,
  sqlstate: string,
) {
  if (
    typeof candidate.schema === "string" &&
    candidate.schema !== "public"
  ) {
    return false;
  }
  if (
    typeof candidate.table === "string" &&
    candidate.table !== "site_builds"
  ) {
    return false;
  }
  if (
    sqlstate === "42704" &&
    typeof candidate.dataType === "string" &&
    candidate.dataType !== "build_state"
  ) {
    return false;
  }
  return true;
}

function safeErrorCauseChain(error: unknown) {
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) {
      break;
    }
    visited.add(current);
    const candidate = current as Record<string, unknown>;
    chain.push(candidate);
    current = candidate.cause;
  }
  return chain;
}

function safeErrorType(
  candidate: Record<string, unknown>,
): DatabaseSchemaDiagnostic["errorType"] {
  const name = candidate.name;
  return typeof name === "string" && SAFE_ERROR_TYPES.has(name)
    ? (name as DatabaseSchemaDiagnostic["errorType"])
    : "UnknownError";
}
