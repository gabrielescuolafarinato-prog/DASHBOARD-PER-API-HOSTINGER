import "server-only";
import { requireDashboardSession } from "@/lib/auth/session";
import { authorizeSiteRecord } from "./policy";

export async function requireSiteAccess(siteId: string) {
  const current = await requireDashboardSession();
  return {
    ...current,
    site: authorizeSiteRecord(siteId, current.site),
  };
}

export async function requireCurrentSiteAccess() {
  return requireDashboardSession();
}
