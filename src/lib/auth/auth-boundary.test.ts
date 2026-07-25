import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("authentication boundary architecture", () => {
  it("keeps one authoritative Better Auth request-session lookup", () => {
    const session = source("src/lib/auth/session.ts");
    const productionFiles = [
      "src/app/page.tsx",
      "src/app/login/page.tsx",
      "src/app/change-password/page.tsx",
      "src/app/onboarding/page.tsx",
      "src/app/(dashboard)/layout.tsx",
      "src/lib/authorization/site-access.ts",
    ].map(source);

    expect(session).toContain("getAuth().api.getSession({");
    expect(session).toContain("headers: await headers()");
    expect(session).toContain("export const getCurrentSession = cache(");
    for (const contents of productionFiles) {
      expect(contents).not.toContain(".api.getSession(");
      expect(contents).not.toContain("getSessionCookie");
    }
  });

  it("makes every session-dependent page explicitly dynamic", () => {
    const pages = [
      "src/app/login/page.tsx",
      "src/app/change-password/page.tsx",
      "src/app/onboarding/page.tsx",
      "src/app/(dashboard)/layout.tsx",
      "src/app/(dashboard)/overview/page.tsx",
      "src/app/(dashboard)/team/page.tsx",
      "src/app/(dashboard)/audit-log/page.tsx",
      "src/app/(dashboard)/site-settings/page.tsx",
      "src/app/(dashboard)/capabilities/page.tsx",
    ];

    for (const page of pages) {
      expect(source(page), page).toContain(
        'export const dynamic = "force-dynamic"',
      );
    }
  });

  it("keeps the onboarding page server-only and secret-free", () => {
    const onboarding = source("src/app/onboarding/page.tsx");

    expect(onboarding).toContain("requireOwnerOnboarding");
    expect(onboarding).toContain("getApplicationSetupStatus");
    expect(onboarding).not.toContain('"use client"');
    expect(onboarding).not.toContain("getHostingerEnv");
    expect(onboarding).not.toContain("HOSTINGER_API_TOKEN");
    expect(onboarding).not.toContain("HOSTINGER_ACCOUNT_USERNAME");
    expect(onboarding).not.toContain("DATABASE_URL");
    expect(onboarding).not.toContain("AUTH_SECRET");
  });

  it("requires authoritative dashboard access at every dashboard page boundary", () => {
    const pages = [
      "src/app/(dashboard)/overview/page.tsx",
      "src/app/(dashboard)/team/page.tsx",
      "src/app/(dashboard)/audit-log/page.tsx",
      "src/app/(dashboard)/site-settings/page.tsx",
      "src/app/(dashboard)/capabilities/page.tsx",
    ];

    for (const page of pages) {
      expect(source(page), page).toContain("requireDashboardSession");
    }
  });

  it("uses one client navigation and no session-observer redirect", () => {
    const form = source("src/app/login/login-form.tsx");
    const flow = source("src/app/login/login-flow.ts");

    expect(form).not.toContain("router.refresh");
    expect(form).not.toContain("router.push");
    expect(form).not.toContain("callbackURL");
    expect(form).not.toContain("useEffect");
    expect(flow.match(/dependencies\.navigate\(/g)).toHaveLength(1);
    expect(form).toContain("disabled={pending}");
  });

  it("updates password state before the one overview redirect", () => {
    const actions = source("src/app/actions.ts");
    const passwordAction = actions.slice(
      actions.indexOf("export async function changePasswordAction"),
      actions.indexOf("export async function logoutAction"),
    );

    expect(passwordAction).toContain("revokeOtherSessions: true");
    expect(passwordAction).toContain(".set({ mustChangePassword: false })");
    expect(passwordAction.match(/redirect\(\"\/overview\"\)/g)).toHaveLength(1);
    expect(passwordAction.indexOf("mustChangePassword: false")).toBeLessThan(
      passwordAction.indexOf('redirect("/overview")'),
    );
  });
});

function source(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}
