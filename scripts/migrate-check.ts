import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolConfig } from "pg";
import type { EnvironmentSource } from "../src/lib/env";
import {
  formatMigrationError,
  loadMigrationEnvironment,
  migrationConnectionConfiguration,
  migrationPoolConfig,
  MigrationRunnerError,
  readExpectedMigrationCount,
  type MigrationRunnerDependencies,
} from "./migrate";

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

export type MigrationCheckResult = {
  expectedCount: number;
  appliedCount: number;
  migrationPending: boolean;
  siteBuildsPresent: boolean;
  buildStatePresent: boolean;
  hostingerOperationsPresent: boolean;
  hostingerOperationStatusPresent: boolean;
  siteDatabasesPresent: boolean;
  hostingerOperationResourceKeyPresent: boolean;
  hostingerOperationScopeIndexesPresent: boolean;
};

export interface MigrationCheckDependencies {
  createPool(config: PoolConfig): Pool;
  readTextFile: MigrationRunnerDependencies["readTextFile"];
  info(message: string): void;
  error(message: string): void;
}

const defaultDependencies: MigrationCheckDependencies = {
  createPool: (config) => new Pool(config),
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export async function runMigrationCheck(options?: {
  env?: EnvironmentSource;
  migrationsFolder?: string;
  dependencies?: MigrationCheckDependencies;
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

  let result: MigrationCheckResult | undefined;
  let failure: unknown;
  try {
    try {
      await pool.query("SELECT 1");
      dependencies.info("Database connection: succeeded.");
    } catch (error) {
      throw new MigrationRunnerError("database connectivity check", error);
    }

    try {
      const objectResult = await pool.query<{
        migration_table: string | null;
        site_builds: string | null;
        build_state: string | null;
        hostinger_operations: string | null;
        hostinger_operation_status: string | null;
        site_databases: string | null;
        hostinger_operations_unscoped_index: string | null;
        hostinger_operations_resource_index: string | null;
        hostinger_operation_resource_key: boolean;
      }>(
        `SELECT
          to_regclass($1)::text AS migration_table,
          to_regclass($2)::text AS site_builds,
          to_regtype($3)::text AS build_state,
          to_regclass($4)::text AS hostinger_operations,
          to_regtype($5)::text AS hostinger_operation_status,
          to_regclass($6)::text AS site_databases,
          to_regclass($7)::text AS hostinger_operations_unscoped_index,
          to_regclass($8)::text AS hostinger_operations_resource_index,
          EXISTS (
            SELECT 1
            FROM pg_attribute
            WHERE attrelid = to_regclass($4)
              AND attname = $9
              AND NOT attisdropped
          ) AS hostinger_operation_resource_key`,
        [
          "drizzle.__drizzle_migrations",
          "public.site_builds",
          "public.build_state",
          "public.hostinger_operations",
          "public.hostinger_operation_status",
          "public.site_databases",
          "public.hostinger_operations_active_unscoped_unique",
          "public.hostinger_operations_active_resource_unique",
          "resource_key_hash",
        ],
      );
      const objects = objectResult.rows[0];
      let appliedCount = 0;
      if (objects?.migration_table) {
        const countResult = await pool.query<{ migration_count: number }>(
          'SELECT count(*)::integer AS migration_count FROM "drizzle"."__drizzle_migrations"',
        );
        appliedCount = countResult.rows[0]?.migration_count;
        if (!Number.isInteger(appliedCount) || appliedCount < 0) {
          throw new MigrationRunnerError(
            "migration verification",
            undefined,
            "The registered migration count was not a valid integer.",
          );
        }
      }

      result = {
        expectedCount,
        appliedCount,
        migrationPending: appliedCount !== expectedCount,
        siteBuildsPresent: Boolean(objects?.site_builds),
        buildStatePresent: Boolean(objects?.build_state),
        hostingerOperationsPresent: Boolean(
          objects?.hostinger_operations,
        ),
        hostingerOperationStatusPresent: Boolean(
          objects?.hostinger_operation_status,
        ),
        siteDatabasesPresent: Boolean(objects?.site_databases),
        hostingerOperationResourceKeyPresent: Boolean(
          objects?.hostinger_operation_resource_key,
        ),
        hostingerOperationScopeIndexesPresent: Boolean(
          objects?.hostinger_operations_unscoped_index &&
            objects?.hostinger_operations_resource_index,
        ),
      };
    } catch (error) {
      if (error instanceof MigrationRunnerError) throw error;
      throw new MigrationRunnerError("migration verification", error);
    }
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
  return result as MigrationCheckResult;
}

export async function runMigrationCheckCli(
  dependencies: MigrationCheckDependencies = defaultDependencies,
) {
  try {
    loadMigrationEnvironment();
    const result = await runMigrationCheck({ dependencies });
    dependencies.info(`Expected migrations: ${result.expectedCount}.`);
    dependencies.info(`Applied migrations: ${result.appliedCount}.`);
    dependencies.info(
      `Migration pending: ${result.migrationPending ? "yes" : "no"}.`,
    );
    dependencies.info(
      `Required object public.site_builds present: ${
        result.siteBuildsPresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required object public.build_state present: ${
        result.buildStatePresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required object public.hostinger_operations present: ${
        result.hostingerOperationsPresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required object public.hostinger_operation_status present: ${
        result.hostingerOperationStatusPresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required object public.site_databases present: ${
        result.siteDatabasesPresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required column public.hostinger_operations.resource_key_hash present: ${
        result.hostingerOperationResourceKeyPresent ? "yes" : "no"
      }.`,
    );
    dependencies.info(
      `Required Hostinger operation scope indexes present: ${
        result.hostingerOperationScopeIndexesPresent ? "yes" : "no"
      }.`,
    );
    return result.migrationPending ||
      !result.siteBuildsPresent ||
      !result.buildStatePresent ||
      !result.hostingerOperationsPresent ||
      !result.hostingerOperationStatusPresent ||
      !result.siteDatabasesPresent ||
      !result.hostingerOperationResourceKeyPresent ||
      !result.hostingerOperationScopeIndexesPresent
      ? 1
      : 0;
  } catch (error) {
    const connectionFailure =
      error instanceof MigrationRunnerError &&
      [
        "connection configuration",
        "pool creation",
        "database connectivity check",
      ].includes(error.operation);
    dependencies.error(
      connectionFailure
        ? "Database connection: failed."
        : "Migration status check: failed.",
    );
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
  void runMigrationCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
