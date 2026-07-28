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
      expectedCount: 3,
      appliedCount: 3,
      migrationPending: false,
      siteBuildsPresent: true,
      buildStatePresent: true,
    });
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("reports a pending migration without modifying the database", async () => {
    const fixture = createDependencies({ appliedCount: 2 });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      expectedCount: 3,
      appliedCount: 2,
      migrationPending: true,
    });
  });

  it("treats a missing Drizzle migration table as zero applied", async () => {
    const fixture = createDependencies({ migrationTablePresent: false });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      expectedCount: 3,
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
    });
  });

  it("reports public.build_state as absent", async () => {
    const fixture = createDependencies({ buildStatePresent: false });

    await expect(check(fixture.dependencies)).resolves.toMatchObject({
      siteBuildsPresent: true,
      buildStatePresent: false,
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
      "Expected migrations: 3.",
      "Applied migrations: 3.",
      "Migration pending: no.",
      "Required object public.site_builds present: yes.",
      "Required object public.build_state present: yes.",
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
          },
        ],
      };
    }
    if (statement.includes("count(*)")) {
      return {
        rows: [{ migration_count: options?.appliedCount ?? 3 }],
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
        entries: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
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
