import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ requireSession }));
vi.mock("./change-password-form", () => ({
  ChangePasswordForm: () => <form aria-label="change password form" />,
}));

import ChangePasswordPage from "./page";

describe("change-password page", () => {
  it("allows its own password-change-required session without self-redirecting", async () => {
    requireSession.mockResolvedValue({
      user: { mustChangePassword: true },
    });

    const markup = renderToStaticMarkup(await ChangePasswordPage());

    expect(requireSession).toHaveBeenCalledWith({
      allowPasswordChange: true,
    });
    expect(markup).toContain("Set a private password");
    expect(markup).toContain('aria-label="change password form"');
  });

  it("remains reachable as a normal password page after completion", async () => {
    requireSession.mockResolvedValue({
      user: { mustChangePassword: false },
    });

    expect(renderToStaticMarkup(await ChangePasswordPage())).toContain(
      "Change your password",
    );
  });
});
