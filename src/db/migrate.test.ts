import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMigrationError,
  MigrationRunnerError,
  runMigrationCli,
  runMigrations,
  type MigrationRunnerDependencies,
} from "../../scripts/migrate";
import { parseMigrationEnv } from "../lib/env";

const safeUrls = {
  migration: "postgresql://migration-user:migration-password@migration.invalid/db",
  unpooled: "postgresql://unpooled-user:unpooled-password@unpooled.invalid/db",
  nonPooling:
    "postgresql://non-pooling-user:non-pooling-password@non-pooling.invalid/db",
  runtime: "postgresql://runtime-user:runtime-password@runtime.invalid/db",
};

const originalMigrationUrl = process.env.DATABASE_MIGRATION_URL;

afterEach(() => {
  if (originalMigrationUrl === undefined) {
    delete process.env.DATABASE_MIGRATION_URL;
  } else {
    process.env.DATABASE_MIGRATION_URL = originalMigrationUrl;
  }
});

describe("migration connection selection", () => {
  it("prioritizes DATABASE_MIGRATION_URL", () => {
    expect(
      parseMigrationEnv({
        DATABASE_MIGRATION_URL: safeUrls.migration,
        DATABASE_URL_UNPOOLED: safeUrls.unpooled,
        POSTGRES_URL_NON_POOLING: safeUrls.nonPooling,
        DATABASE_URL: safeUrls.runtime,
      }),
    ).toEqual({
      connectionString: safeUrls.migration,
      source: "DATABASE_MIGRATION_URL",
    });
  });

  it("falls back to DATABASE_URL_UNPOOLED", () => {
    expect(
      parseMigrationEnv({
        DATABASE_URL_UNPOOLED: safeUrls.unpooled,
        POSTGRES_URL_NON_POOLING: safeUrls.nonPooling,
        DATABASE_URL: safeUrls.runtime,
      }),
    ).toEqual({
      connectionString: safeUrls.unpooled,
      source: "DATABASE_URL_UNPOOLED",
    });
  });

  it("falls back to POSTGRES_URL_NON_POOLING", () => {
    expect(
      parseMigrationEnv({
        POSTGRES_URL_NON_POOLING: safeUrls.nonPooling,
        DATABASE_URL: safeUrls.runtime,
      }),
    ).toEqual({
      connectionString: safeUrls.nonPooling,
      source: "POSTGRES_URL_NON_POOLING",
    });
  });

  it("uses DATABASE_URL as the final fallback", () => {
    expect(parseMigrationEnv({ DATABASE_URL: safeUrls.runtime })).toEqual({
      connectionString: safeUrls.runtime,
      source: "DATABASE_URL",
    });
  });

  it("fails when every supported URL is missing", () => {
    expect(() => parseMigrationEnv({})).toThrow(
      /DATABASE_MIGRATION_URL.*DATABASE_URL_UNPOOLED.*POSTGRES_URL_NON_POOLING.*DATABASE_URL/,
    );
  });

  it("rejects a non-PostgreSQL URL without echoing it", () => {
    const secretUrl = "https://private-user:private-password@private.invalid/db";
    let failure: unknown;
    try {
      parseMigrationEnv({ DATABASE_MIGRATION_URL: secretUrl });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toMatch(/PostgreSQL/);
    expect(message).not.toContain(secretUrl);
    expect(message).not.toContain("private-user");
    expect(message).not.toContain("private-password");
    expect(message).not.toContain("private.invalid");
  });

  it("reports CLI configuration failures without exposing URL values", async () => {
    const fixture = createDependencies();

    await expect(
      runMigrations({
        env: {
          DATABASE_MIGRATION_URL:
            "https://private-user:private-password@private.invalid/db",
        },
        dependencies: fixture.dependencies,
      }),
    ).rejects.toMatchObject({
      operation: "connection configuration",
      safeDetails:
        "Invalid server environment: DATABASE_MIGRATION_URL: must be a PostgreSQL connection URL",
    });
    expect(fixture.dependencies.createPool).not.toHaveBeenCalled();
  });
});

describe("migration runner lifecycle and verification", () => {
  it("closes the Pool after success and verifies the registered count", async () => {
    const fixture = createDependencies({ appliedCount: 4 });
    const result = await runMigrations({
      env: { DATABASE_MIGRATION_URL: safeUrls.migration },
      migrationsFolder: path.resolve("drizzle"),
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({ expectedCount: 4, appliedCount: 4 });
    expect(fixture.applyMigrations).toHaveBeenCalledOnce();
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenCalledWith(
      "SELECT to_regclass($1) AS migration_table",
      ["drizzle.__drizzle_migrations"],
    );
  });

  it("remains safe to rerun when every migration is already registered", async () => {
    const fixture = createDependencies({ appliedCount: 4 });
    const options = {
      env: { DATABASE_MIGRATION_URL: safeUrls.migration },
      dependencies: fixture.dependencies,
    };

    await expect(runMigrations(options)).resolves.toEqual({
      expectedCount: 4,
      appliedCount: 4,
    });
    await expect(runMigrations(options)).resolves.toEqual({
      expectedCount: 4,
      appliedCount: 4,
    });

    expect(fixture.applyMigrations).toHaveBeenCalledTimes(2);
    expect(fixture.end).toHaveBeenCalledTimes(2);
  });

  it("closes the Pool after a migration error", async () => {
    const fixture = createDependencies({
      migrationError: Object.assign(new Error("driver failed"), {
        code: "XX001",
      }),
    });

    await expect(
      runMigrations({
        env: { DATABASE_MIGRATION_URL: safeUrls.migration },
        dependencies: fixture.dependencies,
      }),
    ).rejects.toMatchObject({ operation: "migration application" });
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("fails when fewer migrations are registered than the journal expects", async () => {
    const fixture = createDependencies({ appliedCount: 1 });

    await expect(
      runMigrations({
        env: { DATABASE_MIGRATION_URL: safeUrls.migration },
        dependencies: fixture.dependencies,
      }),
    ).rejects.toMatchObject({
      operation: "migration verification",
      safeDetails:
        "Expected 4 registered migrations but found 1. No migration metadata was changed.",
    });
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("returns a non-zero CLI exit code on failure", async () => {
    process.env.DATABASE_MIGRATION_URL = safeUrls.migration;
    const fixture = createDependencies({
      migrationError: new Error("migration failed"),
    });

    await expect(runMigrationCli(fixture.dependencies)).resolves.toBe(1);
    expect(fixture.error).toHaveBeenCalledWith(
      expect.stringContaining("migration application"),
    );
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("never includes credentials or raw driver messages in formatted errors", () => {
    const driverError = Object.assign(
      new Error(
        "connect postgresql://private-user:private-password@private.invalid/db",
      ),
      { code: "28P01" },
    );
    const message = formatMigrationError(
      new MigrationRunnerError("database connectivity check", driverError),
    );

    expect(message).toContain("database connectivity check");
    expect(message).toContain("code=28P01");
    expect(message).not.toContain("private-user");
    expect(message).not.toContain("private-password");
    expect(message).not.toContain("private.invalid");
    expect(message).not.toContain("postgresql://");
  });
});

describe("migration safety boundaries", () => {
  it("keeps the application runtime on Neon HTTP", async () => {
    const source = await readFile(
      path.resolve("src/db/connection.ts"),
      "utf8",
    );
    expect(source).toContain('from "@neondatabase/serverless"');
    expect(source).toContain('from "drizzle-orm/neon-http"');
    expect(source).not.toContain("node-postgres");
    expect(source).not.toMatch(/from ["']pg["']/);
  });

  it("keeps .env.local ignored by Git", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", ".env.local"], {
        stdio: "ignore",
      }),
    ).not.toThrow();
  });
});

function createDependencies(options?: {
  appliedCount?: number;
  migrationError?: unknown;
}) {
  const appliedCount = options?.appliedCount ?? 4;
  const query = vi.fn(async (queryText: string) => {
    if (queryText.includes("to_regclass")) {
      return {
        rows: [{ migration_table: "drizzle.__drizzle_migrations" }],
      };
    }
    if (queryText.includes("count(*)")) {
      return { rows: [{ migration_count: appliedCount }] };
    }
    return { rows: [{ value: 1 }] };
  });
  const end = vi.fn(async () => undefined);
  const pool = { query, end } as unknown as Pool;
  const applyMigrations = options?.migrationError
    ? vi.fn(async () => {
        throw options.migrationError;
      })
    : vi.fn(async () => undefined);
  const info = vi.fn();
  const error = vi.fn();
  const dependencies: MigrationRunnerDependencies = {
    createPool: vi.fn(() => pool),
    applyMigrations,
    readTextFile: vi.fn(async () =>
      JSON.stringify({
        entries: [
          { idx: 0 },
          { idx: 1 },
          { idx: 2 },
          { idx: 3 },
        ],
      }),
    ),
    info,
    error,
  };
  return {
    dependencies,
    query,
    end,
    applyMigrations,
    info,
    error,
  };
}
