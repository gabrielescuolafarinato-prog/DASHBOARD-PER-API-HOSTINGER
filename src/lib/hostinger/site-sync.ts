import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { siteMemberships, sites, user } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import { getHostingerEnv } from "@/lib/env";
import {
  createHostingerClient,
  type HostingerClient,
  type HostingerWebsite,
} from "@/lib/hostinger/client";
import { normalizeDomain } from "@/lib/hostinger/domain";
import { AppError } from "@/lib/errors";

export function selectExactWebsite(
  configuredDomain: string,
  candidates: HostingerWebsite[],
) {
  const normalized = normalizeDomain(configuredDomain);
  const exact = candidates.filter(
    (candidate) => normalizeDomain(candidate.domain) === normalized,
  );
  if (exact.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "The configured Hostinger site was not found.",
      404,
    );
  }
  if (exact.length > 1) {
    throw new AppError(
      "CONFLICT",
      "Hostinger returned an ambiguous site match.",
      409,
    );
  }
  return exact[0];
}

export async function synchronizeConfiguredSite(
  actorUserId: string,
  client: HostingerClient = createHostingerClient(),
) {
  const env = getHostingerEnv();
  if (!env.HOSTINGER_SITE_DOMAIN || !env.HOSTINGER_ACCOUNT_USERNAME) {
    throw new AppError("HOSTINGER_ERROR", "Hostinger is not configured.", 503);
  }
  const domain = normalizeDomain(env.HOSTINGER_SITE_DOMAIN);
  try {
    const candidates = await client.listWebsitesByDomain(domain);
    const exact = selectExactWebsite(domain, candidates);
    if (
      exact.username &&
      exact.username.trim().toLowerCase() !==
        env.HOSTINGER_ACCOUNT_USERNAME.trim().toLowerCase()
    ) {
      throw new AppError(
        "FORBIDDEN",
        "The Hostinger username does not match the configured account.",
        403,
      );
    }

    const [site] = await getDb()
      .insert(sites)
      .values({
        name: exact.domain,
        primaryDomain: domain,
        hostingerUsername: env.HOSTINGER_ACCOUNT_USERNAME,
        hostingerOrderId: exact.orderId,
        nodeEnabled: exact.nodeEnabled ?? true,
        status: "VERIFIED",
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sites.primaryDomain,
        set: {
          hostingerUsername: env.HOSTINGER_ACCOUNT_USERNAME,
          hostingerOrderId: exact.orderId,
          nodeEnabled: exact.nodeEnabled ?? true,
          status: "VERIFIED",
          lastSyncedAt: new Date(),
        },
      })
      .returning();

    const activeUsers = await getDb()
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.isActive, true));
    if (activeUsers.length > 0) {
      await getDb()
        .insert(siteMemberships)
        .values(
          activeUsers.map((member) => ({
            siteId: site.id,
            userId: member.id,
            role: member.role === "OWNER" ? ("ADMIN" as const) : ("MEMBER" as const),
          })),
        )
        .onConflictDoNothing();
    }
    await writeAuditEvent({
      actorUserId,
      siteId: site.id,
      operation: "hostinger.site.sync",
      targetType: "site",
      targetIdentifier: domain,
      result: "SUCCESS",
      metadata: { matchCount: 1 },
    });
    return site;
  } catch (error) {
    const [existing] = await getDb()
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.primaryDomain, domain))
      .limit(1);
    await writeAuditEvent({
      actorUserId,
      siteId: existing?.id,
      operation: "hostinger.site.sync",
      targetType: "site",
      targetIdentifier: domain,
      result: "FAILURE",
    });
    throw error;
  }
}
