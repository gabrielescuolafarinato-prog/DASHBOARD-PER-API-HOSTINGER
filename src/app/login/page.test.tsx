import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { status: "missing_session" } as { status: string },
  getCurrentDashboardAccess: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentDashboardAccess: mocks.getCurrentDashboardAccess,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("./login-form", () => ({
  LoginForm: () => <form aria-label="login form" />,
}));

import LoginPage from "./page";

describe("login page session routing", () => {
  beforeEach(() => {
    mocks.state = { status: "missing_session" };
    mocks.getCurrentDashboardAccess.mockImplementation(async () => mocks.state);
  });

  it("renders normally for an anonymous request", async () => {
    const markup = renderToStaticMarkup(await LoginPage());

    expect(markup).toContain("Welcome back");
    expect(markup).toContain('aria-label="login form"');
    expect(mocks.getCurrentDashboardAccess).toHaveBeenCalledOnce();
  });

  it("renders normally when a cookie exists but its session does not", async () => {
    mocks.state = { status: "missing_session" };

    expect(renderToStaticMarkup(await LoginPage())).toContain("Welcome back");
  });

  it("renders a safe login for a disabled account", async () => {
    mocks.state = { status: "inactive_user" };

    expect(renderToStaticMarkup(await LoginPage())).toContain("Welcome back");
  });

  it("redirects a fully authorized session once to overview", async () => {
    mocks.state = { status: "authenticated" };

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/overview");
  });

  it("routes mandatory password change directly to its checkpoint", async () => {
    mocks.state = { status: "password_change_required" };

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/change-password");
  });

  it("uses the existing not-found policy for a missing membership", async () => {
    mocks.state = { status: "missing_membership" };

    await expect(LoginPage()).rejects.toThrow("NOT_FOUND");
  });

  it("preserves setup-required behavior", async () => {
    mocks.state = { status: "setup_required" };

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/setup-required");
  });
});
