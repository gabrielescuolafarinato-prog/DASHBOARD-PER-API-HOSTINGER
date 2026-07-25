import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedAuthOrigin, parseCoreEnv } from "@/lib/env";

const databaseUrl =
  "postgresql://test_user:test_password@db.example.invalid/test?sslmode=require";
const authSecret = "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ";

describe("Better Auth deployment origins", () => {
  it("accepts the local origin only in development", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      APP_URL: "http://localhost:3000",
      NODE_ENV: "development",
    });
    expect(env.AUTH_ALLOWED_ORIGINS).toContain("http://localhost:3000");
    expect(env.IS_PRODUCTION).toBe(false);
  });

  it("accepts an exact HTTPS production origin", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      APP_URL: "https://console.example.com",
      NODE_ENV: "production",
    });
    expect(env.AUTH_ALLOWED_HOSTS).toEqual(["console.example.com"]);
  });

  it("accepts the exact Vercel Preview deployment origin", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "hostinger-console-git-feature-acme.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "hostinger-console.vercel.app",
    });
    expect(env.APP_URL).toBe(
      "https://hostinger-console-git-feature-acme.vercel.app",
    );
    expect(env.AUTH_ALLOWED_ORIGINS).toEqual([
      "https://hostinger-console-git-feature-acme.vercel.app",
      "https://hostinger-console.vercel.app",
    ]);
  });

  it("rejects an unknown origin outside the exact allowlist", () => {
    expect(
      isAllowedAuthOrigin("https://attacker.example", [
        "https://console.example.com",
      ]),
    ).toBe(false);
  });

  it("rejects a missing production secret", () => {
    expect(() =>
      parseCoreEnv({
        DATABASE_URL: databaseUrl,
        APP_URL: "https://console.example.com",
        NODE_ENV: "production",
      }),
    ).toThrow(/AUTH_SECRET/);
  });
});

describe("client environment boundary", () => {
  it("does not reference sensitive environment names in Client Components", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const clientFiles = listSourceFiles(sourceRoot).filter((file) => {
      const contents = readFileSync(file, "utf8").trimStart();
      return contents.startsWith('"use client"') || contents.startsWith("'use client'");
    });
    const forbidden = [
      "DATABASE_URL",
      "AUTH_SECRET",
      "HOSTINGER_API_TOKEN",
      "BOOTSTRAP_OWNER_PASSWORD",
      "process.env",
    ];

    for (const file of clientFiles) {
      const contents = readFileSync(file, "utf8");
      for (const name of forbidden) {
        expect(contents, `${path.relative(sourceRoot, file)} exposes ${name}`).not.toContain(
          name,
        );
      }
    }
  });
});

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}
