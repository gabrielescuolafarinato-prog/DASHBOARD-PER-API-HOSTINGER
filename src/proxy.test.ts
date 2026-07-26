import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, isProtectedPath, proxy } from "./proxy";
import {
  AUTH_COOKIE_PREFIX,
  AUTH_SESSION_COOKIE_NAME,
} from "@/lib/auth/cookie-config";

describe("protected pages", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalAppUrl = process.env.APP_URL;

  afterEach(() => {
    restore("DATABASE_URL", originalDatabaseUrl);
    restore("AUTH_SECRET", originalAuthSecret);
    restore("APP_URL", originalAppUrl);
  });

  it("redirects the dashboard to setup-required without configuration", () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    const response = proxy(new NextRequest("https://console.test/overview"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://console.test/setup-required",
    );
  });

  it("redirects an unauthenticated configured dashboard request to login", () => {
    process.env.DATABASE_URL =
      "postgresql://test:test@db.example.invalid/database?sslmode=require";
    process.env.AUTH_SECRET =
      "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ";
    process.env.APP_URL = "https://console.test";
    const response = proxy(new NextRequest("https://console.test/overview"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://console.test/login");
  });

  it("identifies every dashboard area as protected", () => {
    expect(isProtectedPath("/team")).toBe(true);
    expect(isProtectedPath("/audit-log")).toBe(true);
    expect(isProtectedPath("/builds")).toBe(true);
    expect(isProtectedPath("/builds/123/logs")).toBe(true);
    expect(isProtectedPath("/onboarding")).toBe(true);
    expect(isProtectedPath("/login")).toBe(false);
  });

  it("lets the configured Better Auth cookie reach authoritative validation", () => {
    configureApplication();
    const request = new NextRequest("https://console.test/overview", {
      headers: {
        cookie: `__Secure-${AUTH_COOKIE_PREFIX}.${AUTH_SESSION_COOKIE_NAME}=opaque`,
      },
    });
    const response = proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not mistake Better Auth's default prefix for this application's cookie", () => {
    configureApplication();
    const request = new NextRequest("https://console.test/overview", {
      headers: { cookie: "better-auth.session_token=opaque" },
    });
    const response = proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://console.test/login");
  });

  it("always lets login reach its authoritative server check", () => {
    configureApplication();
    const response = proxy(new NextRequest("https://console.test/login"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(config.matcher.join(" ")).not.toContain("/login");
  });

  it("applies setup and anonymous precedence to onboarding", () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    const setupResponse = proxy(
      new NextRequest("https://console.test/onboarding"),
    );
    expect(setupResponse.status).toBe(307);
    expect(setupResponse.headers.get("location")).toBe(
      "https://console.test/setup-required",
    );

    configureApplication();
    const anonymousResponse = proxy(
      new NextRequest("https://console.test/onboarding"),
    );
    expect(anonymousResponse.status).toBe(307);
    expect(anonymousResponse.headers.get("location")).toBe(
      "https://console.test/login",
    );
  });

  it("lets change-password through when the optimistic cookie is present", () => {
    configureApplication();
    const response = proxy(
      new NextRequest("https://console.test/change-password", {
        headers: {
          cookie: `${AUTH_COOKIE_PREFIX}.${AUTH_SESSION_COOKIE_NAME}=opaque`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not intercept Better Auth APIs or static assets", () => {
    expect(isProtectedPath("/api/auth/get-session")).toBe(false);
    expect(isProtectedPath("/_next/static/chunk.js")).toBe(false);
    expect(config.matcher.join(" ")).not.toContain("/api/auth");
    expect(config.matcher.join(" ")).not.toContain("/_next");
  });
});

function configureApplication() {
  process.env.DATABASE_URL =
    "postgresql://test:test@db.example.invalid/database?sslmode=require";
  process.env.AUTH_SECRET =
    "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ";
  process.env.APP_URL = "https://console.test";
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
