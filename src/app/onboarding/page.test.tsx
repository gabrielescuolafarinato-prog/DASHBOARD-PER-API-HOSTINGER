import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerOnboarding: vi.fn(),
  hostingerConfigured: false,
}));

vi.mock("@/lib/auth/session", () => ({
  requireOwnerOnboarding: mocks.requireOwnerOnboarding,
}));
vi.mock("@/lib/env", () => ({
  getApplicationSetupStatus: () => ({
    hostingerConfigured: mocks.hostingerConfigured,
  }),
}));
vi.mock("@/app/actions", () => ({
  logoutAction: vi.fn(),
}));

import OnboardingPage from "./page";

describe("owner onboarding page", () => {
  beforeEach(() => {
    mocks.hostingerConfigured = false;
    mocks.requireOwnerOnboarding.mockReset();
    mocks.requireOwnerOnboarding.mockResolvedValue({
      user: {
        name: "Production Owner",
        role: "OWNER",
        isActive: true,
      },
    });
  });

  it("renders only for the authorized OWNER onboarding state", async () => {
    const markup = renderToStaticMarkup(await OnboardingPage());

    expect(mocks.requireOwnerOnboarding).toHaveBeenCalledOnce();
    expect(markup).toContain("Configurazione iniziale richiesta");
    expect(markup).toContain("Account OWNER attivo");
    expect(markup).toContain("non è ancora");
    expect(markup).toContain("Non configurata");
    expect(markup).toContain("Logout");
  });

  it("shows only the generic configured status", async () => {
    mocks.hostingerConfigured = true;
    const markup = renderToStaticMarkup(await OnboardingPage());

    expect(markup).toContain("Configurata");
    expect(markup).not.toContain("HOSTINGER_API_TOKEN");
    expect(markup).not.toContain("HOSTINGER_ACCOUNT_USERNAME");
    expect(markup).not.toContain("DATABASE_URL");
    expect(markup).not.toContain("AUTH_SECRET");
  });

  it.each([
    ["authenticated", "/overview"],
    ["missing_session", "/login"],
    ["password_change_required", "/change-password"],
    ["missing_membership", "NOT_FOUND"],
    ["inactive_user", "/login"],
  ])("does not render for %s", async (_status, outcome) => {
    mocks.requireOwnerOnboarding.mockRejectedValue(
      new Error(
        outcome === "NOT_FOUND" ? "NOT_FOUND" : `REDIRECT:${outcome}`,
      ),
    );

    await expect(OnboardingPage()).rejects.toThrow(
      outcome === "NOT_FOUND" ? outcome : `REDIRECT:${outcome}`,
    );
  });
});
