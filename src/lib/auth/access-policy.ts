export type DashboardAccessStatus =
  | "setup_required"
  | "missing_session"
  | "inactive_user"
  | "password_change_required"
  | "owner_onboarding_required"
  | "missing_membership"
  | "invalid_site_membership"
  | "ambiguous_site_memberships"
  | "access_error"
  | "authenticated";

export type AccessSurface = "root" | "login" | "dashboard" | "onboarding";

export type AccessDecision =
  | { action: "allow" }
  | {
      action: "redirect";
      destination:
        | "/setup-required"
        | "/login"
        | "/change-password"
        | "/onboarding"
        | "/overview";
    }
  | { action: "not_found" }
  | { action: "invalid_site" }
  | { action: "ambiguous_site" }
  | { action: "access_error" };

/**
 * The single routing matrix for every session-aware entry point.
 *
 * Statuses are already ordered by the authoritative lookup: setup, session,
 * account state and password state are resolved before site access.
 */
export function resolveAccessDecision(
  status: DashboardAccessStatus,
  surface: AccessSurface,
): AccessDecision {
  if (status === "setup_required") {
    return { action: "redirect", destination: "/setup-required" };
  }
  if (status === "missing_session" || status === "inactive_user") {
    return surface === "login"
      ? { action: "allow" }
      : { action: "redirect", destination: "/login" };
  }
  if (status === "password_change_required") {
    return { action: "redirect", destination: "/change-password" };
  }
  if (status === "owner_onboarding_required") {
    return surface === "onboarding"
      ? { action: "allow" }
      : { action: "redirect", destination: "/onboarding" };
  }
  if (status === "missing_membership") {
    return { action: "not_found" };
  }
  if (status === "invalid_site_membership") {
    return { action: "invalid_site" };
  }
  if (status === "ambiguous_site_memberships") {
    return { action: "ambiguous_site" };
  }
  if (status === "access_error") {
    return { action: "access_error" };
  }
  if (surface === "dashboard") {
    return { action: "allow" };
  }
  return { action: "redirect", destination: "/overview" };
}
