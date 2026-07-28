import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";
import {
  parseMigrationEnv,
  ServerEnvironmentError,
  type EnvironmentSource,
} from "../src/lib/env";

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");
const DISPLAY_MIGRATIONS_FOLDER = "./drizzle";

type MigrationOperation =
  | "journal validation"
  | "connection configuration"
  | "pool creation"
  | "database connectivity check"
  | "migration application"
  | "migration verification"
  | "pool shutdown";

export class MigrationRunnerError extends Error {
  constructor(
    readonly operation: MigrationOperation,
    readonly originalError?: unknown,
    readonly safeDetails?: string,
  ) {
    super(`Migration failed during ${operation}.`);
    this.name = "MigrationRunnerError";
  }
}

export interface MigrationRunnerDependencies {
  createPool(config: PoolConfig): Pool;
  applyMigrations(pool: Pool, migrationsFolder: string): Promise<void>;
  readTextFile(filePath: string): Promise<string>;
  info(message: string): void;
  error(message: string): void;
}

const defaultDependencies: MigrationRunnerDependencies = {
  createPool: (config) => new Pool(config),
  applyMigrations: async (pool, migrationsFolder) => {
    await migrate(drizzle(pool), { migrationsFolder });
  },
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export function loadMigrationEnvironment() {
  loadDotenv({ path: ".env.local", override: false, quiet: true });
  loadDotenv({ path: ".env", override: false, quiet: true });
}

export async function readExpectedMigrationCount(
  migrationsFolder: string,
  readTextFile: MigrationRunnerDependencies["readTextFile"] = defaultDependencies.readTextFile,
) {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  try {
    const journal = JSON.parse(await readTextFile(journalPath)) as {
      entries?: unknown;
    };
    if (!Array.isArray(journal.entries)) {
      throw new Error("Journal entries are missing.");
    }
    return journal.entries.length;
  } catch (error) {
    throw new MigrationRunnerError(
      "journal validation",
      error,
      "The versioned migration journal could not be validated.",
    );
  }
}

export function migrationPoolConfig(
  connectionString: string,
): PoolConfig {
  return {
    connectionString,
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  };
}

export function migrationConnectionConfiguration(
  env: EnvironmentSource,
) {
  try {
    return parseMigrationEnv(env);
  } catch (error) {
    throw new MigrationRunnerError(
      "connection configuration",
      error,
      error instanceof ServerEnvironmentError ? error.message : undefined,
    );
  }
}

async function verifyAppliedMigrations(
  pool: Pool,
  expectedCount: number,
): Promise<number> {
  const tableResult = await pool.query<{ migration_table: string | null }>(
    "SELECT to_regclass($1) AS migration_table",
    ["drizzle.__drizzle_migrations"],
  );
  if (!tableResult.rows[0]?.migration_table) {
    throw new MigrationRunnerError(
      "migration verification",
      undefined,
      "The Drizzle migration table was not found after migration.",
    );
  }

  const countResult = await pool.query<{ migration_count: number }>(
    'SELECT count(*)::integer AS migration_count FROM "drizzle"."__drizzle_migrations"',
  );
  const appliedCount = countResult.rows[0]?.migration_count;
  if (!Number.isInteger(appliedCount)) {
    throw new MigrationRunnerError(
      "migration verification",
      undefined,
      "The registered migration count was not a valid integer.",
    );
  }
  if (appliedCount !== expectedCount) {
    throw new MigrationRunnerError(
      "migration verification",
      undefined,
      `Expected ${expectedCount} registered migrations but found ${appliedCount}. No migration metadata was changed.`,
    );
  }
  return appliedCount;
}

export async function runMigrations(options?: {
  env?: EnvironmentSource;
  migrationsFolder?: string;
  dependencies?: MigrationRunnerDependencies;
}) {
  const dependencies = options?.dependencies ?? defaultDependencies;
  const migrationsFolder =
    options?.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const expectedCount = await readExpectedMigrationCount(
    migrationsFolder,
    dependencies.readTextFile,
  );
  const { connectionString } = migrationConnectionConfiguration(
    options?.env ?? process.env,
  );

  let pool: Pool;
  try {
    pool = dependencies.createPool(
      migrationPoolConfig(connectionString),
    );
  } catch (error) {
    throw new MigrationRunnerError("pool creation", error);
  }

  let failure: unknown;
  let appliedCount: number | undefined;
  try {
    try {
      await pool.query("SELECT 1");
      dependencies.info("Database connection verified.");
    } catch (error) {
      throw new MigrationRunnerError("database connectivity check", error);
    }

    dependencies.info(`Migration folder: ${DISPLAY_MIGRATIONS_FOLDER}`);
    try {
      await dependencies.applyMigrations(pool, migrationsFolder);
    } catch (error) {
      throw new MigrationRunnerError("migration application", error);
    }

    try {
      appliedCount = await verifyAppliedMigrations(pool, expectedCount);
    } catch (error) {
      if (error instanceof MigrationRunnerError) throw error;
      throw new MigrationRunnerError("migration verification", error);
    }
    dependencies.info("Migrations completed.");
    dependencies.info(`Registered migrations: ${appliedCount}.`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await pool.end();
    } catch (error) {
      failure ??= new MigrationRunnerError("pool shutdown", error);
    }
  }

  if (failure) throw failure;
  return { expectedCount, appliedCount: appliedCount as number };
}

function safeToken(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : undefined;
}

export function formatMigrationError(error: unknown) {
  const runnerError =
    error instanceof MigrationRunnerError
      ? error
      : new MigrationRunnerError("migration application", error);
  const original = runnerError.originalError;
  const metadata =
    original && typeof original === "object"
      ? {
          name: safeToken("name" in original ? original.name : undefined),
          code: safeToken("code" in original ? original.code : undefined),
        }
      : {};
  const labels = [
    metadata.name ? `name=${metadata.name}` : undefined,
    metadata.code ? `code=${metadata.code}` : undefined,
  ].filter(Boolean);
  const suffix = labels.length > 0 ? ` (${labels.join(", ")})` : "";
  const details =
    runnerError.safeDetails ??
    "Connection details and raw driver messages were not logged.";
  return `Migration failed during ${runnerError.operation}${suffix}. ${details}`;
}

export async function runMigrationCli(
  dependencies: MigrationRunnerDependencies = defaultDependencies,
) {
  try {
    loadMigrationEnvironment();
    await runMigrations({ dependencies });
    return 0;
  } catch (error) {
    dependencies.error(formatMigrationError(error));
    return 1;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(
    entry &&
      import.meta.url === pathToFileURL(path.resolve(entry)).href,
  );
}

if (isMainModule()) {
  void runMigrationCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
