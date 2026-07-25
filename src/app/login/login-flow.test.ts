import { describe, expect, it, vi } from "vitest";
import {
  createSubmissionGate,
  executeLogin,
  LOGIN_SUCCESS_DESTINATION,
} from "./login-flow";

describe("client sign-in flow", () => {
  it("performs exactly one navigation after a successful sign-in", async () => {
    const signIn = vi.fn(async () => ({ error: null }));
    const navigate = vi.fn();

    await expect(
      executeLogin(
        { email: "user@example.test", password: "not-a-real-password" },
        { signIn, navigate },
      ),
    ).resolves.toBe("success");

    expect(signIn).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledWith({
      email: "user@example.test",
      password: "not-a-real-password",
      rememberMe: true,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(LOGIN_SUCCESS_DESTINATION);
  });

  it("shows an authentication outcome without navigating", async () => {
    const navigate = vi.fn();

    await expect(
      executeLogin(
        { email: "user@example.test", password: "incorrect" },
        {
          signIn: vi.fn(async () => ({ error: { code: "INVALID" } })),
          navigate,
        },
      ),
    ).resolves.toBe("auth_error");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("contains an unexpected response failure without navigating", async () => {
    const navigate = vi.fn();

    await expect(
      executeLogin(
        { email: "user@example.test", password: "incorrect" },
        {
          signIn: vi.fn(async () => {
            throw new Error("network unavailable");
          }),
          navigate,
        },
      ),
    ).resolves.toBe("unexpected_error");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("prevents a second submission until the first one finishes", () => {
    const gate = createSubmissionGate();

    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
    gate.end();
    expect(gate.begin()).toBe(true);
  });
});
