import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getAuth, type AuthSession } from "@/lib/auth";
import { getDb } from "@/db";
import { siteMemberships, sites } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { getApplicationSetupStatus } from "@/lib/env";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import {
  resolveAccessDecision,
  type AccessSurface,
} from "./access-policy";
import { isAccountActive, requiresPasswordChange } from "./session-policy";

type SessionUser = Omit<
  AuthSession["user"],
  "isActive" | "mustChangePassword" | "role"
> & {
  isActive: true;
  mustChangePassword: boolean;
  role: "OWNER" | "COLLABORATOR";
};

export type AuthenticatedSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
  user: SessionUser;
};

export type CurrentSessionState =
  | { status: "setup_required" }
  | { status: "missing_session" }
  | { status: "inactive_user" }
  | {
      status: "password_change_required";
      current: AuthenticatedSession;
    }
  | {
      status: "authenticated";
      current: AuthenticatedSession;
    };

export type CurrentDashboardAccessState =
  | Exclude<CurrentSessionState, { status: "authenticated" }>
  | {
      status: "missing_membership";
      current: AuthenticatedSession;
    }
  | {
      status: "owner_onboarding_required";
      current: AuthenticatedSession;
    }
  | {
      status: "invalid_site_membership";
      current: AuthenticatedSession;
    }
  | {
      status: "ambiguous_site_memberships";
      current: AuthenticatedSession;
    }
  | {
      status: "access_error";
      current: AuthenticatedSession;
    }
  | {
      status: "authenticated";
      current: AuthenticatedSession & { site: SiteAccessRecord };
    };

export type SiteMembershipCandidate = {
  membershipSiteId: string;
  siteId: string | null;
  name: string | null;
  primaryDomain: string | null;
  hostingerUsername: string | null;
  siteStatus: "UNCONFIGURED" | "VERIFIED" | "ERROR" | null;
  membershipRole: "ADMIN" | "MEMBER";
};

/**
 * The single authoritative session lookup for the current request.
 *
 * Better Auth validates the signed cookie and its database-backed session using
 * the real request headers. React cache only deduplicates calls made while
 * rendering this request; no session result is stored globally.
 */
export const getCurrentSession = cache(
  async (): Promise<CurrentSessionState> => {
    if (!getApplicationSetupStatus().applicationConfigured) {
      return { status: "setup_required" };
    }

    const current = await getAuth().api.getSession({
      headers: await headers(),
    });
    if (!current) return { status: "missing_session" };

    const user = normalizeSessionUser(current.user);
    if (!user || current.user.banned === true) {
      return { status: "inactive_user" };
    }

    const authenticated = {
      session: {
        id: current.session.id,
        userId: current.session.userId,
        expiresAt: current.session.expiresAt,
      },
      user,
    };
    if (requiresPasswordChange(user)) {
      return {
        status: "password_change_required",
        current: authenticated,
      };
    }

    return { status: "authenticated", current: authenticated };
  },
);

function normalizeSessionUser(
  candidate: AuthSession["user"],
): SessionUser | null {
  if (
    !isAccountActive(candidate) ||
    typeof candidate.mustChangePassword !== "boolean" ||
    (candidate.role !== "OWNER" && candidate.role !== "COLLABORATOR")
  ) {
    return null;
  }
  return {
    ...candidate,
    isActive: true,
    mustChangePassword: candidate.mustChangePassword,
    role: candidate.role,
  };
}

/**
 * Adds the single-site membership boundary to the authoritative auth state.
 */
export const getCurrentDashboardAccess = cache(
  async (): Promise<CurrentDashboardAccessState> => {
    const state = await getCurrentSession();
    if (state.status !== "authenticated") return state;

    let memberships: SiteMembershipCandidate[];
    try {
      memberships = await getDb()
        .select({
          membershipSiteId: siteMemberships.siteId,
          siteId: sites.id,
          name: sites.name,
          primaryDomain: sites.primaryDomain,
          hostingerUsername: sites.hostingerUsername,
          siteStatus: sites.status,
          membershipRole: siteMemberships.role,
        })
        .from(siteMemberships)
        .leftJoin(sites, eq(siteMemberships.siteId, sites.id))
        .where(eq(siteMemberships.userId, state.current.user.id))
        .limit(2);
    } catch {
      return { status: "access_error", current: state.current };
    }

    return resolveUserSiteAccess(state.current, memberships);
  },
);

export function resolveUserSiteAccess(
  current: AuthenticatedSession,
  memberships: SiteMembershipCandidate[],
): CurrentDashboardAccessState {
  if (memberships.length === 0) {
    return {
      status:
        current.user.role === "OWNER"
          ? "owner_onboarding_required"
          : "missing_membership",
      current,
    };
  }
  if (memberships.length > 1) {
    return { status: "ambiguous_site_memberships", current };
  }

  const [membership] = memberships;
  if (
    membership.membershipSiteId !== membership.siteId ||
    membership.siteStatus !== "VERIFIED" ||
    !membership.name ||
    !membership.primaryDomain ||
    !membership.hostingerUsername
  ) {
    return { status: "invalid_site_membership", current };
  }

  return {
    status: "authenticated",
    current: {
      ...current,
      site: {
        siteId: membership.siteId,
        name: membership.name,
        primaryDomain: membership.primaryDomain,
        hostingerUsername: membership.hostingerUsername,
        membershipRole: membership.membershipRole,
      },
    },
  };
}

export async function authorizeCurrentSurface(surface: AccessSurface) {
  const state = await getCurrentDashboardAccess();
  const decision = resolveAccessDecision(state.status, surface);
  if (decision.action === "redirect") redirect(decision.destination);
  if (decision.action === "not_found") notFound();
  if (decision.action === "invalid_site") {
    throw new AppError(
      "FORBIDDEN",
      "The associated site is not available.",
      403,
    );
  }
  if (decision.action === "ambiguous_site") {
    throw new AppError(
      "CONFLICT",
      "Multiple site memberships violate the single-site boundary.",
      409,
    );
  }
  if (decision.action === "access_error") {
    throw new AppError(
      "INTERNAL_ERROR",
      "Site access could not be verified.",
      503,
    );
  }
  return state;
}

export async function requireSession(options?: {
  allowPasswordChange?: boolean;
}) {
  const state = await getCurrentSession();
  if (state.status === "setup_required") redirect("/setup-required");
  if (
    state.status === "missing_session" ||
    state.status === "inactive_user"
  ) {
    redirect("/login");
  }
  if (state.status === "password_change_required") {
    if (options?.allowPasswordChange) return state.current;
    redirect("/change-password");
  }
  return state.current;
}

export async function requireDashboardSession() {
  const state = await authorizeCurrentSurface("dashboard");
  if (state.status !== "authenticated") {
    throw new AppError(
      "INTERNAL_ERROR",
      "Dashboard authorization did not resolve.",
      500,
    );
  }
  return state.current;
}

export async function requireOwnerOnboarding() {
  const state = await authorizeCurrentSurface("onboarding");
  if (state.status !== "owner_onboarding_required") {
    throw new AppError(
      "INTERNAL_ERROR",
      "Owner onboarding authorization did not resolve.",
      500,
    );
  }
  return state.current;
}

export async function requireOwner(options?: {
  allowPasswordChange?: boolean;
}) {
  const current = options?.allowPasswordChange
    ? await requireSession(options)
    : await requireDashboardSession();
  if (current.user.role !== "OWNER") {
    throw new AppError("FORBIDDEN", "Owner access is required.", 403);
  }
  return current;
}
