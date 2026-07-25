import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/proxy";
import {
  AUTH_COOKIE_PREFIX,
  AUTH_SESSION_COOKIE_NAME,
} from "@/lib/auth/cookie-config";

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  APP_URL: process.env.APP_URL,
};

describe("real redirect-loop regression", () => {
  beforeEach(() => {
    process.env.DATABASE_URL =
      "postgresql://test:test@db.example.invalid/database?sslmode=require";
    process.env.AUTH_SECRET =
      "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ";
    process.env.APP_URL = "https://console.test";
  });

  afterEach(() => {
    restore("DATABASE_URL", originalEnvironment.DATABASE_URL);
    restore("AUTH_SECRET", originalEnvironment.AUTH_SECRET);
    restore("APP_URL", originalEnvironment.APP_URL);
  });

  it("finishes at overview after sign-in returns the configured session cookie", () => {
    const signInRequest = new Request(
      "https://console.test/api/auth/sign-in/email",
      {
        method: "POST",
        body: JSON.stringify({
          email: "user@example.test",
          password: "not-a-real-password",
        }),
      },
    );
    const signInResponse = successfulSignInResponse(signInRequest);
    const cookie = signInResponse.headers.get("set-cookie")?.split(";", 1)[0];

    expect(signInRequest.method).toBe("POST");
    expect(signInResponse.status).toBe(200);
    expect(cookie).toMatch(
      new RegExp(
        `^__Secure-${AUTH_COOKIE_PREFIX}\\.${AUTH_SESSION_COOKIE_NAME}=`,
      ),
    );

    const result = simulateRequest("/overview", cookie, "authenticated");
    expect(result.status).toBe(200);
    expect(result.redirects).toEqual([]);
    expect(result.visited).toEqual(["/overview"]);
  });

  it("uses one redirect for a present cookie whose database session is gone", () => {
    const cookie =
      `__Secure-${AUTH_COOKIE_PREFIX}.${AUTH_SESSION_COOKIE_NAME}=expired`;
    const result = simulateRequest("/overview", cookie, "missing_session");

    expect(result.status).toBe(200);
    expect(result.redirects).toEqual(["/login"]);
    expect(result.visited).toEqual(["/overview", "/login"]);
    expect(result.redirects.length).toBeLessThanOrEqual(1);
  });

  it("fails the historical alternating redirect signature", () => {
    const cookie =
      `__Secure-${AUTH_COOKIE_PREFIX}.${AUTH_SESSION_COOKIE_NAME}=opaque`;
    const valid = simulateRequest("/overview", cookie, "authenticated");
    const expired = simulateRequest("/overview", cookie, "missing_session");
    const historicalLoop = [
      "/overview",
      "/login",
      "/overview",
      "/login",
    ];

    expect(valid.visited).not.toEqual(historicalLoop);
    expect(expired.visited).not.toEqual(historicalLoop);
    expect(Math.max(valid.redirects.length, expired.redirects.length)).toBe(1);
  });
});

type AuthoritativeStatus = "authenticated" | "missing_session";

function simulateRequest(
  initialPath: "/overview",
  cookie: string | undefined,
  authoritativeStatus: AuthoritativeStatus,
) {
  const visited: string[] = [];
  const redirects: string[] = [];
  let path: "/overview" | "/login" = initialPath;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    visited.push(path);
    const request = new NextRequest(`https://console.test${path}`, {
      headers: cookie ? { cookie } : undefined,
    });
    const optimisticResponse = proxy(request);
    const optimisticLocation = optimisticResponse.headers.get("location");
    if (optimisticLocation) {
      path = new URL(optimisticLocation).pathname as "/overview" | "/login";
      redirects.push(path);
      continue;
    }

    const authoritativeResponse = renderRoute(path, authoritativeStatus);
    const authoritativeLocation =
      authoritativeResponse.headers.get("location");
    if (!authoritativeLocation) {
      return {
        status: authoritativeResponse.status,
        redirects,
        visited,
      };
    }
    path = new URL(authoritativeLocation).pathname as "/overview" | "/login";
    redirects.push(path);
  }

  throw new Error(`redirect loop detected: ${visited.join(" -> ")}`);
}

function renderRoute(
  path: "/overview" | "/login",
  status: AuthoritativeStatus,
) {
  if (path === "/overview" && status === "missing_session") {
    return NextResponse.redirect("https://console.test/login");
  }
  if (path === "/login" && status === "authenticated") {
    return NextResponse.redirect("https://console.test/overview");
  }
  return new NextResponse("ok", { status: 200 });
}

function successfulSignInResponse(request: Request) {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/api/auth/sign-in/email"
  ) {
    return new Response(null, { status: 405 });
  }
  return new Response(JSON.stringify({ user: { id: "opaque-user-id" } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie":
        `__Secure-${AUTH_COOKIE_PREFIX}.${AUTH_SESSION_COOKIE_NAME}=signed; ` +
        "Path=/; HttpOnly; Secure; SameSite=Lax",
    },
  });
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
