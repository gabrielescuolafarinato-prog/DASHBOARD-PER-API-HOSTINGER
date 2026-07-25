import { AppError } from "@/lib/errors";

export type SiteAccessRecord = {
  siteId: string;
  name: string;
  primaryDomain: string;
  hostingerUsername: string;
  membershipRole: "ADMIN" | "MEMBER";
};

export function authorizeSiteRecord(
  requestedSiteId: string,
  membership: SiteAccessRecord | undefined,
) {
  if (!membership || membership.siteId !== requestedSiteId) {
    throw new AppError("NOT_FOUND", "Site not found.", 404);
  }
  return membership;
}
