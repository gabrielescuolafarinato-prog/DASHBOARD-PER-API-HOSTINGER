import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { getApplicationSetupStatus } from "@/lib/env";
import { AUTH_SESSION_COOKIE_LOOKUP } from "@/lib/auth/cookie-config";

export const protectedPrefixes = [
  "/overview",
  "/builds",
  "/team",
  "/site-settings",
  "/capabilities",
  "/audit-log",
  "/change-password",
  "/onboarding",
] as const;

export function isProtectedPath(pathname: string) {
  return protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function proxy(request: NextRequest) {
  if (
    isProtectedPath(request.nextUrl.pathname) &&
    !getApplicationSetupStatus().applicationConfigured
  ) {
    return NextResponse.redirect(new URL("/setup-required", request.url));
  }
  if (
    isProtectedPath(request.nextUrl.pathname) &&
    !getSessionCookie(request, AUTH_SESSION_COOKIE_LOOKUP)
  ) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/overview/:path*",
    "/builds/:path*",
    "/team/:path*",
    "/site-settings/:path*",
    "/capabilities/:path*",
    "/audit-log/:path*",
    "/change-password",
    "/onboarding",
  ],
};
