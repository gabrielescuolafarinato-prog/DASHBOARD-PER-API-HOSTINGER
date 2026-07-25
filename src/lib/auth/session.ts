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
      status: "authenticated";
      current: AuthenticatedSession & { site: SiteAccessRecord };
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

    const memberships = await getDb()
      .select({
        siteId: sites.id,
        name: sites.name,
        primaryDomain: sites.primaryDomain,
        hostingerUsername: sites.hostingerUsername,
        membershipRole: siteMemberships.role,
      })
      .from(siteMemberships)
      .innerJoin(sites, eq(siteMemberships.siteId, sites.id))
      .where(eq(siteMemberships.userId, state.current.user.id))
      .limit(2);

    if (memberships.length !== 1) {
      return {
        status: "missing_membership",
        current: state.current,
      };
    }

    return {
      status: "authenticated",
      current: { ...state.current, site: memberships[0] },
    };
  },
);

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
  const state = await getCurrentDashboardAccess();
  if (state.status === "setup_required") redirect("/setup-required");
  if (
    state.status === "missing_session" ||
    state.status === "inactive_user"
  ) {
    redirect("/login");
  }
  if (state.status === "password_change_required") {
    redirect("/change-password");
  }
  if (state.status === "missing_membership") notFound();
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
