import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerOnboarding: vi.fn(),
  hostinger: {
    status: "unconfigured" as
      | "unconfigured"
      | "incomplete"
      | "invalid"
      | "ready",
    configured: false,
    domain: undefined as string | undefined,
  },
}));

vi.mock("@/lib/auth/session", () => ({
  requireOwnerOnboarding: mocks.requireOwnerOnboarding,
}));
vi.mock("@/lib/env", () => ({
  getApplicationSetupStatus: () => ({
    hostingerConfigured: mocks.hostinger.configured,
    hostinger: mocks.hostinger.configured
      ? {
          status: "ready",
          configured: true,
          domain: mocks.hostinger.domain,
        }
      : {
          status: mocks.hostinger.status,
          configured: false,
        },
  }),
}));
vi.mock("@/app/actions", () => ({
  logoutAction: vi.fn(),
  verifyHostingerSiteAction: vi.fn(),
  importHostingerSiteAction: vi.fn(),
}));

import OnboardingPage from "./page";

describe("owner onboarding page", () => {
  beforeEach(() => {
    mocks.hostinger.status = "unconfigured";
    mocks.hostinger.configured = false;
    mocks.hostinger.domain = undefined;
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
    expect(markup).toContain("Hostinger non configurato");
    expect(markup).toContain("HOSTINGER_API_TOKEN");
    expect(markup).toContain("HOSTINGER_ACCOUNT_USERNAME");
    expect(markup).toContain("HOSTINGER_SITE_DOMAIN");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Logout");
  });

  it("shows only the safe configured domain and ready status", async () => {
    mocks.hostinger.status = "ready";
    mocks.hostinger.configured = true;
    mocks.hostinger.domain = "example.com";
    const markup = renderToStaticMarkup(await OnboardingPage());

    expect(markup).toContain("Pronto per la verifica");
    expect(markup).toContain("example.com");
    expect(markup).toContain("Verifica sito Hostinger");
    expect(markup).not.toContain("HOSTINGER_API_TOKEN");
    expect(markup).not.toContain("HOSTINGER_ACCOUNT_USERNAME");
    expect(markup).not.toContain("DATABASE_URL");
    expect(markup).not.toContain("AUTH_SECRET");
  });

  it.each([
    ["incomplete", "Configurazione incompleta"],
    ["invalid", "Errore controllato"],
  ])("renders the controlled %s state", async (status, label) => {
    mocks.hostinger.status = status as "incomplete" | "invalid";
    const markup = renderToStaticMarkup(await OnboardingPage());
    expect(markup).toContain(label);
    expect(markup).not.toContain("server-secret-value");
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
