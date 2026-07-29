import "server-only";
import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/errors";

const SAFE_ERROR_TYPES = new Set([
  "DatabaseError",
  "DrizzleError",
  "DrizzleQueryError",
  "Error",
  "NeonDbError",
  "PostgresError",
]);

export function databaseMigrationRequiredError(error: unknown) {
  for (const candidate of safeErrorCauseChain(error)) {
    const code = candidate.code;
    if (code !== "42P01" && code !== "42703") continue;
    if (
      typeof candidate.schema === "string" &&
      candidate.schema !== "public"
    ) {
      continue;
    }
    if (
      typeof candidate.table === "string" &&
      candidate.table !== "site_databases"
    ) {
      continue;
    }
    const referenceId = randomBytes(6).toString("hex");
    const name = candidate.name;
    console.error("database_schema_diagnostic", {
      referenceId,
      phase: "site_database_binding",
      sqlstate: code,
      errorType:
        typeof name === "string" && SAFE_ERROR_TYPES.has(name)
          ? name
          : "UnknownError",
      expectedMigration: "0004",
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
}

function safeErrorCauseChain(error: unknown) {
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
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
