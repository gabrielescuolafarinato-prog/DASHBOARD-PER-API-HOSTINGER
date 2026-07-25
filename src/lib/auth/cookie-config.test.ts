import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_PREFIX,
  AUTH_DEFAULT_COOKIE_ATTRIBUTES,
  AUTH_SESSION_COOKIE_LOOKUP,
  AUTH_SESSION_COOKIE_NAME,
} from "./cookie-config";

describe("Better Auth cookie configuration", () => {
  it("uses one cookie name and prefix in Better Auth and the proxy", () => {
    expect(AUTH_SESSION_COOKIE_LOOKUP).toEqual({
      cookiePrefix: AUTH_COOKIE_PREFIX,
      cookieName: AUTH_SESSION_COOKIE_NAME,
    });
    expect(AUTH_COOKIE_PREFIX).toBe("hostinger-console");

    const authSource = source("src/lib/auth.ts");
    const proxySource = source("src/proxy.ts");
    expect(authSource).toContain("cookiePrefix: AUTH_COOKIE_PREFIX");
    expect(proxySource).toContain("AUTH_SESSION_COOKIE_LOOKUP");
    expect(proxySource).not.toContain("getSessionCookie(request)");
  });

  it("keeps the session cookie host-only and safe by default", () => {
    expect(AUTH_DEFAULT_COOKIE_ATTRIBUTES).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(AUTH_DEFAULT_COOKIE_ATTRIBUTES).not.toHaveProperty("domain");

    const authSource = source("src/lib/auth.ts");
    expect(authSource).toContain("useSecureCookies: env.IS_PRODUCTION");
    expect(authSource).toContain(
      "defaultCookieAttributes: AUTH_DEFAULT_COOKIE_ATTRIBUTES",
    );
    expect(authSource).not.toMatch(/domain\s*:/i);
    expect(authSource).not.toContain(
      "dashboard-per-api-hostinger.vercel.app",
    );
  });
});

function source(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}
