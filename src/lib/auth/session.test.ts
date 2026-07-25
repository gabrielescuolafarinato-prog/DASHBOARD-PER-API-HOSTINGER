import { describe, expect, it } from "vitest";
import { isAccountActive, requiresPasswordChange } from "./session-policy";

describe("session security state", () => {
  it("invalidates a disabled user immediately", () => {
    expect(isAccountActive({ isActive: false })).toBe(false);
  });

  it("forces the temporary-password checkpoint", () => {
    expect(requiresPasswordChange({ mustChangePassword: true })).toBe(true);
  });
});
