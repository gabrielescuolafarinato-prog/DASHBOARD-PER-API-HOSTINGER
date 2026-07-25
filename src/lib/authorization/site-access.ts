import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { siteMemberships, sites } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { authorizeSiteRecord } from "./policy";

export async function requireSiteAccess(siteId: string) {
  const current = await requireSession();
  const [membership] = await getDb()
    .select({
      siteId: sites.id,
      name: sites.name,
      primaryDomain: sites.primaryDomain,
      hostingerUsername: sites.hostingerUsername,
      membershipRole: siteMemberships.role,
    })
    .from(siteMemberships)
    .innerJoin(sites, eq(siteMemberships.siteId, sites.id))
    .where(
      and(
        eq(siteMemberships.userId, current.user.id),
        eq(siteMemberships.siteId, siteId),
      ),
    )
    .limit(1);

  return { ...current, site: authorizeSiteRecord(siteId, membership) };
}

export async function requireCurrentSiteAccess() {
  const current = await requireSession();
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
    .where(eq(siteMemberships.userId, current.user.id))
    .limit(2);

  if (memberships.length !== 1) {
    throw new AppError(
      "NOT_FOUND",
      "No single configured site is available for this account.",
      404,
    );
  }
  return { ...current, site: memberships[0] };
}
