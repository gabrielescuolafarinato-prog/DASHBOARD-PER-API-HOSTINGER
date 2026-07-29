import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runMigrationCheck,
  runMigrationCheckCli,
  type MigrationCheckDependencies,
} from "../../scripts/migrate-check";

const migrationUrl =
  "postgresql://migration-user:migration-password@migration.invalid/db";
const originalMigrationUrl = process.env.DATABASE_MIGRATION_URL;

afterEach(() => {
  if (originalMigrationUrl === undefined) {
    delete process.env.DATABASE_MIGRATION_URL;
  } else {
    process.env.DATABASE_MIGRATION_URL = originalMigrationUrl;
  }
});

describe("read-only migration status check", () => {
  it("reports all migrations and required build objects as ready", async () => {
    const fixture = createDependencies();

    await expect(check(fixture.dependencies)).resolves.toEqual({
      expectedCount: 5,
      appliedCount: 5,
      migrationPending: false,
      siteBuildsPresent: true,
      buildStatePresent: true,
      hostingerOperationsPresent: true,
      hostingerOperationStatusPresent: true,
      siteDatabasesPresent: true,
      hostingerOperationResourceKeyPresent: true,
      hostingerOperationScopeIndexesPresent: true,
    });
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("reports a pending migration without modifying the database", async () => {
    const fixture = createDependencies({ appliedCount: 2 });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      expectedCount: 5,
      appliedCount: 2,
      migrationPending: true,
    });
  });

  it("treats a missing Drizzle migration table as zero applied", async () => {
    const fixture = createDependencies({ migrationTablePresent: false });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      expectedCount: 5,
      appliedCount: 0,
      migrationPending: true,
    });
    expect(
      fixture.query.mock.calls.some(([statement]) =>
        String(statement).includes("count(*)"),
      ),
    ).toBe(false);
  });

  it("reports public.site_builds as absent", async () => {
    const fixture = createDependencies({ siteBuildsPresent: false });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      siteBuildsPresent: false,
      buildStatePresent: true,
      hostingerOperationsPresent: true,
      hostingerOperationStatusPresent: true,
      siteDatabasesPresent: true,
      hostingerOperationResourceKeyPresent: true,
      hostingerOperationScopeIndexesPresent: true,
    });
  });

  it("reports public.build_state as absent", async () => {
    const fixture = createDependencies({ buildStatePresent: false });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      siteBuildsPresent: true,
      buildStatePresent: false,
      hostingerOperationsPresent: true,
      hostingerOperationStatusPresent: true,
      siteDatabasesPresent: true,
      hostingerOperationResourceKeyPresent: true,
      hostingerOperationScopeIndexesPresent: true,
    });
  });

  it("reports the durable Hostinger operation objects as absent", async () => {
    const fixture = createDependencies({
      hostingerOperationsPresent: false,
      hostingerOperationStatusPresent: false,
    });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      hostingerOperationsPresent: false,
      hostingerOperationStatusPresent: false,
    });
  });

  it("reports migration 0004 objects as absent", async () => {
    const fixture = createDependencies({
      siteDatabasesPresent: false,
      hostingerOperationResourceKeyPresent: false,
      hostingerOperationScopeIndexesPresent: false,
    });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      siteDatabasesPresent: false,
      hostingerOperationResourceKeyPresent: false,
      hostingerOperationScopeIndexesPresent: false,
    });
  });

  it("executes only read-only SELECT statements", async () => {
    const fixture = createDependencies();

    await check(fixture.dependencies);

    const statements = fixture.query.mock.calls.map(([statement]) =>
      String(statement).trim(),
    );
    expect(statements).toHaveLength(3);
    expect(statements.every((statement) => /^SELECT\b/i.test(statement))).toBe(
      true,
    );
    expect(statements.join("\n")).not.toMatch(
      /\b(?:insert|update|delete|alter|create|drop|truncate)\b/i,
    );
  });

  it("prints only safe readiness information", async () => {
    process.env.DATABASE_MIGRATION_URL = migrationUrl;
    const fixture = createDependencies();

    await expect(
      runMigrationCheckCli(fixture.dependencies),
    ).resolves.toBe(0);

    expect(fixture.info.mock.calls.flat()).toEqual([
      "Database connection: succeeded.",
      "Expected migrations: 5.",
      "Applied migrations: 5.",
      "Migration pending: no.",
      "Required object public.site_builds present: yes.",
      "Required object public.build_state present: yes.",
      "Required object public.hostinger_operations present: yes.",
      "Required object public.hostinger_operation_status present: yes.",
      "Required object public.site_databases present: yes.",
      "Required column public.hostinger_operations.resource_key_hash present: yes.",
      "Required Hostinger operation scope indexes present: yes.",
    ]);
    const output = JSON.stringify([
      fixture.info.mock.calls,
      fixture.error.mock.calls,
    ]);
    expect(output).not.toMatch(
      /migration-user|migration-password|migration\.invalid|postgresql:\/\//,
    );
  });
});

function check(dependencies: MigrationCheckDependencies) {
  return runMigrationCheck({
    env: { DATABASE_MIGRATION_URL: migrationUrl },
    dependencies,
  });
}

function createDependencies(options?: {
  appliedCount?: number;
  migrationTablePresent?: boolean;
  siteBuildsPresent?: boolean;
  buildStatePresent?: boolean;
  hostingerOperationsPresent?: boolean;
  hostingerOperationStatusPresent?: boolean;
  siteDatabasesPresent?: boolean;
  hostingerOperationResourceKeyPresent?: boolean;
  hostingerOperationScopeIndexesPresent?: boolean;
}) {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("to_regclass")) {
      return {
        rows: [
          {
            migration_table:
              options?.migrationTablePresent === false
                ? null
                : "drizzle.__drizzle_migrations",
            site_builds:
              options?.siteBuildsPresent === false
                ? null
                : "public.site_builds",
            build_state:
              options?.buildStatePresent === false
                ? null
                : "public.build_state",
            hostinger_operations:
              options?.hostingerOperationsPresent === false
                ? null
                : "public.hostinger_operations",
            hostinger_operation_status:
              options?.hostingerOperationStatusPresent === false
                ? null
                : "public.hostinger_operation_status",
            site_databases:
              options?.siteDatabasesPresent === false
                ? null
                : "public.site_databases",
            hostinger_operations_unscoped_index:
              options?.hostingerOperationScopeIndexesPresent === false
                ? null
                : "public.hostinger_operations_active_unscoped_unique",
            hostinger_operations_resource_index:
              options?.hostingerOperationScopeIndexesPresent === false
                ? null
                : "public.hostinger_operations_active_resource_unique",
            hostinger_operation_resource_key:
              options?.hostingerOperationResourceKeyPresent !== false,
          },
        ],
      };
    }
    if (statement.includes("count(*)")) {
      return {
        rows: [{ migration_count: options?.appliedCount ?? 5 }],
      };
    }
    return { rows: [{ value: 1 }] };
  });
  const end = vi.fn(async () => undefined);
  const pool = { query, end } as unknown as Pool;
  const dependencies: MigrationCheckDependencies = {
    createPool: vi.fn(() => pool),
    readTextFile: vi.fn(async () =>
      JSON.stringify({
        entries: [
          { idx: 0 },
          { idx: 1 },
          { idx: 2 },
          { idx: 3 },
          { idx: 4 },
        ],
      }),
    ),
    info: vi.fn(),
    error: vi.fn(),
  };
  return {
    dependencies,
    query,
    end,
    info: dependencies.info as ReturnType<typeof vi.fn>,
    error: dependencies.error as ReturnType<typeof vi.fn>,
  };
}
