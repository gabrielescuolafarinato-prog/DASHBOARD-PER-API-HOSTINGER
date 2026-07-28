import "server-only";
import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/errors";

const MAX_ERROR_CAUSE_DEPTH = 4;
const MIGRATION_SQLSTATES = new Set(["42P01", "42704"]);
const SAFE_ERROR_TYPES = new Set([
  "DatabaseError",
  "DrizzleError",
  "DrizzleQueryError",
  "Error",
  "NeonDbError",
  "PostgresError",
]);

export function operationMigrationRequiredError(error: unknown) {
  const match = findMigrationError(error);
  if (!match) return undefined;

  const referenceId = randomBytes(6).toString("hex");
  console.error("database_schema_diagnostic", {
    referenceId,
    phase: "hostinger_operation",
    sqlstate: match.sqlstate,
    errorType: match.errorType,
    expectedMigration: "0003",
    result: "failure",
  });

  return new AppError(
    "DATABASE_MIGRATION_REQUIRED",
    "Database update required.",
    503,
    undefined,
    referenceId,
  );
}

function findMigrationError(error: unknown) {
  for (const candidate of safeErrorCauseChain(error)) {
    const sqlstate = candidate.code;
    if (
      typeof sqlstate !== "string" ||
      !MIGRATION_SQLSTATES.has(sqlstate)
    ) {
      continue;
    }
    if (
      typeof candidate.schema === "string" &&
      candidate.schema !== "public"
    ) {
      continue;
    }
    if (
      typeof candidate.table === "string" &&
      candidate.table !== "hostinger_operations"
    ) {
      continue;
    }
    if (
      sqlstate === "42704" &&
      typeof candidate.dataType === "string" &&
      candidate.dataType !== "hostinger_operation_status"
    ) {
      continue;
    }
    return {
      sqlstate: sqlstate as "42P01" | "42704",
      errorType: safeErrorType(candidate),
    };
  }
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

function safeErrorType(candidate: Record<string, unknown>) {
  const name = candidate.name;
  return typeof name === "string" && SAFE_ERROR_TYPES.has(name)
    ? name
    : "UnknownError";
}
