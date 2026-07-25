import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isProtectedPath, proxy } from "./proxy";

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
    expect(isProtectedPath("/login")).toBe(false);
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
