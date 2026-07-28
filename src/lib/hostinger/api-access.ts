import "server-only";
import { getCurrentDashboardAccess } from "@/lib/auth/session";
import { writeAuditEvent } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  hasHostingerSiteAccess,
  type HostingerSiteCapability,
} from "./permissions";

export async function requireHostingerApiAccess(
  capability: HostingerSiteCapability,
) {
  const state = await getCurrentDashboardAccess();
  if (state.status === "authenticated") {
    if (
      hasHostingerSiteAccess(
        state.current.site.membershipRole,
        capability,
      )
    ) {
      return state.current;
    }
    await auditDenied(state.current.user.id, state.current.site.siteId, {
      capability,
      reason: "permission_denied",
    });
    throw new AppError("FORBIDDEN", "Permission denied.", 403);
  }

  const actorUserId = "current" in state ? state.current.user.id : undefined;
  await auditDenied(actorUserId, undefined, {
    capability,
    reason: state.status,
  });

  if (state.status === "missing_session") {
    throw new AppError(
      "UNAUTHENTICATED",
      "Authentication is required.",
      401,
    );
  }
  if (
    state.status === "owner_onboarding_required" ||
    state.status === "missing_membership"
  ) {
    throw new AppError("NOT_FOUND", "Site not found.", 404);
  }
  if (
    state.status === "inactive_user" ||
    state.status === "password_change_required" ||
    state.status === "invalid_site_membership"
  ) {
    throw new AppError("FORBIDDEN", "Access denied.", 403);
  }
  if (state.status === "ambiguous_site_memberships") {
    throw new AppError(
      "CONFLICT",
      "Site access could not be resolved.",
      409,
    );
  }
  throw new AppError(
    "INTERNAL_ERROR",
    "Site access could not be verified.",
    503,
  );
}

async function auditDenied(
  actorUserId: string | undefined,
  siteId: string | undefined,
  metadata: { capability: HostingerSiteCapability; reason: string },
) {
  try {
    await writeAuditEvent({
      actorUserId,
      siteId,
      operation: "hostinger_access_denied",
      targetType: "site",
      result: "DENIED",
      metadata,
    });
  } catch {
    // Do not replace the access decision with a secondary audit failure.
  }
}
