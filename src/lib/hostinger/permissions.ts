import { AppError } from "@/lib/errors";
import { getCapability } from "./capabilities";

export const hostingerSiteCapabilities = [
  "node.builds.list",
  "node.build.logs",
  "node.restart",
] as const;

export type HostingerSiteCapability =
  (typeof hostingerSiteCapabilities)[number];

const siteScopedCategories = new Set([
  "SITE_DIRECT",
  "SITE_RESOURCE",
  "DOMAIN_ASSET",
]);

/**
 * Fixed Hostinger policy for the authoritative single-site membership.
 *
 * There are no per-user grants: every implemented, registered and site-scoped
 * Hostinger capability is available to ADMIN and MEMBER alike. Planned,
 * account-wide, owner-administrative and unknown capabilities fail closed.
 */
export function hasHostingerSiteAccess(
  membershipRole: "ADMIN" | "MEMBER",
  capabilityKey: string,
) {
  const capability = getCapability(capabilityKey);
  return (
    (membershipRole === "ADMIN" || membershipRole === "MEMBER") &&
    capability.state === "IMPLEMENTED" &&
    siteScopedCategories.has(capability.category)
  );
}

export function assertHostingerSiteAccess(
  membershipRole: "ADMIN" | "MEMBER",
  capabilityKey: HostingerSiteCapability,
) {
  if (!hasHostingerSiteAccess(membershipRole, capabilityKey)) {
    throw new AppError("FORBIDDEN", "Permission denied.", 403);
  }
}
