import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDynamicBaseURL } from "better-auth";
import { describe, expect, it } from "vitest";
import { isAllowedAuthOrigin, parseCoreEnv } from "@/lib/env";

const databaseUrl =
  "postgresql://test_user:test_password@db.example.invalid/test?sslmode=require";
const authSecret = "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ";

describe("Better Auth deployment origins", () => {
  it("authorizes every exact Vercel host from the reported production failure", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      APP_URL: "https://dashboard-per-api-hostinger.vercel.app",
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_URL:
        "dashboard-per-api-hostinger-1xyqqozei-gabriele13.vercel.app",
      VERCEL_BRANCH_URL:
        "dashboard-per-api-hostinger-git-main-gabriele13.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL:
        "dashboard-per-api-hostinger.vercel.app",
    });

    expect(env.AUTH_ALLOWED_HOSTS).toEqual([
      "dashboard-per-api-hostinger.vercel.app",
      "dashboard-per-api-hostinger-1xyqqozei-gabriele13.vercel.app",
      "dashboard-per-api-hostinger-git-main-gabriele13.vercel.app",
    ]);
    expect(env.AUTH_ALLOWED_ORIGINS).toEqual(
      env.AUTH_ALLOWED_HOSTS.map((host) => `https://${host}`),
    );
    expect(env.AUTH_ALLOWED_HOSTS).not.toContain(
      ["nome-reale-del-progetto", "vercel", "app"].join("."),
    );
    expect(
      resolveDynamicBaseURL(
        {
          allowedHosts: env.AUTH_ALLOWED_HOSTS,
          protocol: env.AUTH_BASE_URL_PROTOCOL,
        },
        new Request(
          "https://dashboard-per-api-hostinger-git-main-gabriele13.vercel.app/api/auth/sign-in/email",
        ),
        "/api/auth",
      ),
    ).toBe(
      "https://dashboard-per-api-hostinger-git-main-gabriele13.vercel.app/api/auth",
    );
  });

  it("accepts the local origin only in development", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      APP_URL: "http://localhost:3000",
      NODE_ENV: "development",
    });
    expect(env.AUTH_ALLOWED_ORIGINS).toContain("http://localhost:3000");
    expect(env.AUTH_ALLOWED_HOSTS).toEqual(["localhost:3000"]);
    expect(env.AUTH_BASE_URL_PROTOCOL).toBe("http");
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
    expect(env.AUTH_ALLOWED_ORIGINS).toEqual(["https://console.example.com"]);
    expect(env.AUTH_BASE_URL_PROTOCOL).toBe("https");
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

  it("accepts exact branch and project Production origins", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_BRANCH_URL: "hostinger-console-git-main-acme.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "hostinger-console.vercel.app",
    });
    expect(env.AUTH_ALLOWED_HOSTS).toEqual([
      "hostinger-console-git-main-acme.vercel.app",
      "hostinger-console.vercel.app",
    ]);
  });

  it("normalizes case and trailing dots and removes duplicates deterministically", () => {
    const env = parseCoreEnv({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      APP_URL: "https://HOSTINGER-CONSOLE.VERCEL.APP.",
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_URL: "HOSTINGER-CONSOLE-GIT-MAIN-ACME.VERCEL.APP.",
      VERCEL_BRANCH_URL: "hostinger-console-git-main-acme.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "HOSTINGER-CONSOLE.VERCEL.APP",
    });
    expect(env.AUTH_ALLOWED_HOSTS).toEqual([
      "hostinger-console.vercel.app",
      "hostinger-console-git-main-acme.vercel.app",
    ]);
    expect(env.AUTH_ALLOWED_ORIGINS).toEqual([
      "https://hostinger-console.vercel.app",
      "https://hostinger-console-git-main-acme.vercel.app",
    ]);
  });

  it("rejects an unknown origin outside the exact allowlist", () => {
    const allowedHosts = ["console.example.com"];
    expect(isAllowedAuthOrigin("https://attacker.example", [
      "https://console.example.com",
    ])).toBe(false);
    expect(() =>
      resolveDynamicBaseURL(
        { allowedHosts, protocol: "https" },
        new Request("https://attacker.example/api/auth/sign-in/email"),
        "/api/auth",
      ),
    ).toThrow(/not in the allowed hosts list/);
  });

  it.each([
    ["domain suffix confusion", "example.vercel.app.evil.com"],
    ["protocol", "https://example.vercel.app"],
    ["path", "example.vercel.app/path"],
    ["query", "example.vercel.app?redirect=evil"],
    ["fragment", "example.vercel.app#fragment"],
    ["credentials", "user@example.vercel.app"],
    ["wildcard", "*.vercel.app"],
    ["missing domain boundary", "evilvercel.app"],
    ["newline", "example.vercel.app\nattacker.example"],
  ])("rejects a VERCEL_BRANCH_URL containing %s", (_case, branchUrl) => {
    expect(() =>
      parseCoreEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        APP_URL: "https://console.example.com",
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_BRANCH_URL: branchUrl,
      }),
    ).toThrow(/VERCEL_BRANCH_URL/);
  });

  it("rejects localhost in Production", () => {
    expect(() =>
      parseCoreEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        APP_URL: "http://localhost:3000",
        NODE_ENV: "production",
      }),
    ).toThrow(/HTTPS|Localhost/);
  });

  it("rejects mixing local HTTP with Vercel HTTPS hosts", () => {
    expect(() =>
      parseCoreEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        APP_URL: "http://localhost:3000",
        NODE_ENV: "development",
        VERCEL: "1",
        VERCEL_URL: "hostinger-console-git-feature-acme.vercel.app",
      }),
    ).toThrow(/cannot be combined/);
  });

  it("rejects incomplete or non-origin APP_URL values", () => {
    for (const appUrl of [
      "console.example.com",
      "https://console.example.com/path",
      "https://user@console.example.com",
      "https://console.example.com?next=/login",
    ]) {
      expect(() =>
        parseCoreEnv({
          DATABASE_URL: databaseUrl,
          AUTH_SECRET: authSecret,
          APP_URL: appUrl,
          NODE_ENV: "production",
        }),
      ).toThrow(/APP_URL/);
    }
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
