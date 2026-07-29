import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schema = read("src/db/schema.ts");
const service = read("src/lib/hostinger/database-service.ts");
const migration = read("drizzle/0004_site_databases.sql");

describe("site database persistence boundary", () => {
  it("stores only non-sensitive verified database binding fields", () => {
    const table = schema.slice(
      schema.indexOf("export const siteDatabases"),
      schema.indexOf("export const hostingerOperations"),
    );
    expect(table).toContain('name: text("name")');
    expect(table).toContain('databaseUser: text("database_user")');
    expect(table).toContain('verifiedDomain: text("verified_domain")');
    expect(table).toContain('diskUsageMb: integer("disk_usage_mb")');
    expect(table).toContain('maxSizeMb: integer("max_size_mb")');
    expect(table).toContain('lastVerifiedAt: timestamp("last_verified_at"');
    expect(table).not.toMatch(
      /password|phpmyadmin|connection.?string|database.?host|remote.?ip|payload|permissions/i,
    );
  });

  it("uses an idempotent upsert that cannot reassign an existing name across sites", () => {
    expect(schema).toContain("site_databases_name_key_unique");
    expect(service).toContain("onConflictDoUpdate");
    expect(service).toContain(
      "setWhere: eq(siteDatabases.siteId, siteId)",
    );
    expect(service).toContain(
      '"Database ownership could not be verified."',
    );
  });

  it("keeps migration 0004 append-only and adds durable per-resource operation scopes", () => {
    expect(migration).toContain('CREATE TABLE "site_databases"');
    expect(migration).toContain(
      'ALTER TABLE "hostinger_operations" ADD COLUMN "resource_key_hash" text',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "hostinger_operations_active_resource_unique"',
    );
    expect(migration).not.toMatch(
      /DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "site_databases"/i,
    );
  });

  it("never persists phpMyAdmin links or passwords", () => {
    const bindingWrite = service.slice(
      service.indexOf(".insert(siteDatabases)"),
      service.indexOf(".onConflictDoUpdate", service.indexOf(".insert(siteDatabases)")),
    );
    expect(bindingWrite).not.toMatch(
      /password|phpmyadmin|connection.?string|remote.?ip/i,
    );
    expect(migration).not.toMatch(/password|phpmyadmin|signon/i);
  });
});

function read(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}
