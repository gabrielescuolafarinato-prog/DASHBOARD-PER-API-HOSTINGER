import { describe, expect, it } from "vitest";
import {
  resolveAccessDecision,
  type AccessSurface,
  type DashboardAccessStatus,
} from "./access-policy";

describe("central access redirect matrix", () => {
  it.each([
    ["setup_required", "login", "redirect", "/setup-required"],
    ["setup_required", "onboarding", "redirect", "/setup-required"],
    ["missing_session", "root", "redirect", "/login"],
    ["missing_session", "login", "allow", undefined],
    ["missing_session", "onboarding", "redirect", "/login"],
    ["inactive_user", "login", "allow", undefined],
    ["inactive_user", "onboarding", "redirect", "/login"],
    [
      "password_change_required",
      "onboarding",
      "redirect",
      "/change-password",
    ],
    [
      "owner_onboarding_required",
      "root",
      "redirect",
      "/onboarding",
    ],
    [
      "owner_onboarding_required",
      "login",
      "redirect",
      "/onboarding",
    ],
    [
      "owner_onboarding_required",
      "dashboard",
      "redirect",
      "/onboarding",
    ],
    ["owner_onboarding_required", "onboarding", "allow", undefined],
    ["missing_membership", "dashboard", "not_found", undefined],
    ["missing_membership", "onboarding", "not_found", undefined],
    ["authenticated", "dashboard", "allow", undefined],
    ["authenticated", "root", "redirect", "/overview"],
    ["authenticated", "login", "redirect", "/overview"],
    ["authenticated", "onboarding", "redirect", "/overview"],
  ] satisfies Array<
    [
      DashboardAccessStatus,
      AccessSurface,
      ReturnType<typeof resolveAccessDecision>["action"],
      string | undefined,
    ]
  >)(
    "%s on %s resolves to %s",
    (status, surface, action, destination) => {
      const result = resolveAccessDecision(status, surface);

      expect(result.action).toBe(action);
      expect(
        result.action === "redirect" ? result.destination : undefined,
      ).toBe(destination);
    },
  );

  it("keeps invalid, ambiguous and database access states distinct", () => {
    expect(
      resolveAccessDecision("invalid_site_membership", "dashboard").action,
    ).toBe("invalid_site");
    expect(
      resolveAccessDecision("ambiguous_site_memberships", "dashboard").action,
    ).toBe("ambiguous_site");
    expect(
      resolveAccessDecision("access_error", "dashboard").action,
    ).toBe("access_error");
  });
});
