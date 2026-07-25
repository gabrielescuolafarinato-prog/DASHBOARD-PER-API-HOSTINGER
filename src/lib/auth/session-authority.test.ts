import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  applicationConfigured: true,
  requestHeaders: new Headers({ cookie: "opaque=request-cookie" }),
  authSession: null as unknown,
  memberships: [] as unknown[],
  getSession: vi.fn(),
  membershipLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => state.requestHeaders),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/env", () => ({
  getApplicationSetupStatus: () => ({
    applicationConfigured: state.applicationConfigured,
  }),
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: state.getSession,
    },
  }),
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: state.membershipLimit,
          }),
        }),
      }),
    }),
  }),
}));

describe("authoritative request session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.applicationConfigured = true;
    state.authSession = validAuthSession();
    state.memberships = [validMembership()];
    state.getSession.mockImplementation(async () => state.authSession);
    state.membershipLimit.mockImplementation(async () => state.memberships);
  });

  it("validates Better Auth with the real request headers", async () => {
    const { getCurrentSession } = await import("./session");
    const result = await getCurrentSession();

    expect(result.status).toBe("authenticated");
    expect(state.getSession).toHaveBeenCalledOnce();
    expect(state.getSession).toHaveBeenCalledWith({
      headers: state.requestHeaders,
    });
    expect(JSON.stringify(result)).not.toContain(
      "not-exposed-by-the-service",
    );
  });

  it("distinguishes setup-required without initializing Better Auth", async () => {
    state.applicationConfigured = false;
    const { getCurrentSession } = await import("./session");

    expect(await getCurrentSession()).toEqual({ status: "setup_required" });
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it("distinguishes an absent or expired database session", async () => {
    state.authSession = null;
    const { getCurrentSession } = await import("./session");

    expect(await getCurrentSession()).toEqual({ status: "missing_session" });
  });

  it("rejects a disabled user even when Better Auth returns a session", async () => {
    state.authSession = validAuthSession({ isActive: false });
    const { getCurrentSession, requireDashboardSession } =
      await import("./session");

    expect(await getCurrentSession()).toEqual({ status: "inactive_user" });
    await expect(requireDashboardSession()).rejects.toThrow("REDIRECT:/login");
    expect(state.membershipLimit).not.toHaveBeenCalled();
  });

  it("distinguishes the mandatory password checkpoint", async () => {
    state.authSession = validAuthSession({ mustChangePassword: true });
    const { getCurrentSession, requireSession } = await import("./session");

    expect((await getCurrentSession()).status).toBe(
      "password_change_required",
    );
    await expect(requireSession()).rejects.toThrow(
      "REDIRECT:/change-password",
    );
    await expect(
      requireSession({ allowPasswordChange: true }),
    ).resolves.toMatchObject({
      user: { mustChangePassword: true },
    });
  });

  it("accepts exactly one current-site membership", async () => {
    const { getCurrentDashboardAccess, requireDashboardSession } =
      await import("./session");

    expect(await getCurrentDashboardAccess()).toMatchObject({
      status: "authenticated",
      current: {
        user: { id: "11111111-1111-4111-8111-111111111111" },
        site: { primaryDomain: "example.test" },
      },
    });
    await expect(requireDashboardSession()).resolves.toMatchObject({
      site: { membershipRole: "ADMIN" },
    });
  });

  it("routes an OWNER with zero memberships to onboarding", async () => {
    state.memberships = [];
    const {
      getCurrentDashboardAccess,
      requireDashboardSession,
      requireOwnerOnboarding,
    } = await import("./session");

    expect((await getCurrentDashboardAccess()).status).toBe(
      "owner_onboarding_required",
    );
    await expect(requireDashboardSession()).rejects.toThrow(
      "REDIRECT:/onboarding",
    );
    await expect(requireOwnerOnboarding()).resolves.toMatchObject({
      user: { role: "OWNER" },
    });
  });

  it("keeps a COLLABORATOR without membership on the not-found policy", async () => {
    state.authSession = validAuthSession({ role: "COLLABORATOR" });
    state.memberships = [];
    const { getCurrentDashboardAccess, requireDashboardSession } =
      await import("./session");

    expect((await getCurrentDashboardAccess()).status).toBe(
      "missing_membership",
    );
    await expect(requireDashboardSession()).rejects.toThrow("NOT_FOUND");
  });

  it("does not authorize a membership whose site no longer exists", async () => {
    state.memberships = [
      {
        ...validMembership(),
        siteId: null,
        name: null,
        primaryDomain: null,
        hostingerUsername: null,
        siteStatus: null,
      },
    ];
    const { getCurrentDashboardAccess, requireDashboardSession } =
      await import("./session");

    expect((await getCurrentDashboardAccess()).status).toBe(
      "invalid_site_membership",
    );
    await expect(requireDashboardSession()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it.each(["ERROR", "UNCONFIGURED"] as const)(
    "does not authorize a site in %s state",
    async (siteStatus) => {
      state.memberships = [{ ...validMembership(), siteStatus }];
      const { getCurrentDashboardAccess } = await import("./session");

      expect((await getCurrentDashboardAccess()).status).toBe(
        "invalid_site_membership",
      );
    },
  );

  it("does not select a site when multiple memberships exist", async () => {
    state.memberships = [
      validMembership(),
      {
        ...validMembership(),
        membershipSiteId: "44444444-4444-4444-8444-444444444444",
        siteId: "44444444-4444-4444-8444-444444444444",
        primaryDomain: "other.example.test",
      },
    ];
    const { getCurrentDashboardAccess, requireDashboardSession } =
      await import("./session");

    expect((await getCurrentDashboardAccess()).status).toBe(
      "ambiguous_site_memberships",
    );
    await expect(requireDashboardSession()).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("keeps database errors distinct from missing membership and onboarding", async () => {
    state.membershipLimit.mockRejectedValue(
      new Error("database unavailable"),
    );
    const { getCurrentDashboardAccess, requireDashboardSession } =
      await import("./session");

    expect((await getCurrentDashboardAccess()).status).toBe("access_error");
    await expect(requireDashboardSession()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 503,
    });
  });
});

function validAuthSession(
  overrides: Partial<{
    isActive: boolean;
    mustChangePassword: boolean;
    banned: boolean;
    role: "OWNER" | "COLLABORATOR";
  }> = {},
) {
  return {
    session: {
      id: "22222222-2222-4222-8222-222222222222",
      token: "not-exposed-by-the-service",
      userId: "11111111-1111-4111-8111-111111111111",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Test User",
      email: "user@example.test",
      emailVerified: true,
      image: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      isActive: true,
      mustChangePassword: false,
      banned: false,
      role: "OWNER",
      ...overrides,
    },
  };
}

function validMembership() {
  return {
    membershipSiteId: "33333333-3333-4333-8333-333333333333",
    siteId: "33333333-3333-4333-8333-333333333333",
    name: "Production",
    primaryDomain: "example.test",
    hostingerUsername: "u123",
    siteStatus: "VERIFIED",
    membershipRole: "ADMIN",
  };
}
