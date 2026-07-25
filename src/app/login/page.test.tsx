import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeCurrentSurface: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  authorizeCurrentSurface: mocks.authorizeCurrentSurface,
}));

vi.mock("./login-form", () => ({
  LoginForm: () => <form aria-label="login form" />,
}));

import LoginPage from "./page";

describe("login page session routing", () => {
  beforeEach(() => {
    mocks.authorizeCurrentSurface.mockReset();
    mocks.authorizeCurrentSurface.mockResolvedValue({
      status: "missing_session",
    });
  });

  it("renders normally for an anonymous request", async () => {
    const markup = renderToStaticMarkup(await LoginPage());

    expect(markup).toContain("Welcome back");
    expect(markup).toContain('aria-label="login form"');
    expect(mocks.authorizeCurrentSurface).toHaveBeenCalledOnce();
    expect(mocks.authorizeCurrentSurface).toHaveBeenCalledWith("login");
  });

  it("renders normally when a cookie exists but its session does not", async () => {
    expect(renderToStaticMarkup(await LoginPage())).toContain("Welcome back");
  });

  it("renders a safe login for a disabled account", async () => {
    mocks.authorizeCurrentSurface.mockResolvedValue({
      status: "inactive_user",
    });

    expect(renderToStaticMarkup(await LoginPage())).toContain("Welcome back");
  });

  it("redirects a fully authorized session once to overview", async () => {
    mocks.authorizeCurrentSurface.mockRejectedValue(
      new Error("REDIRECT:/overview"),
    );

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/overview");
  });

  it("routes mandatory password change directly to its checkpoint", async () => {
    mocks.authorizeCurrentSurface.mockRejectedValue(
      new Error("REDIRECT:/change-password"),
    );

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/change-password");
  });

  it("routes an OWNER without membership to onboarding", async () => {
    mocks.authorizeCurrentSurface.mockRejectedValue(
      new Error("REDIRECT:/onboarding"),
    );

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("preserves setup-required behavior", async () => {
    mocks.authorizeCurrentSurface.mockRejectedValue(
      new Error("REDIRECT:/setup-required"),
    );

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/setup-required");
  });
});
