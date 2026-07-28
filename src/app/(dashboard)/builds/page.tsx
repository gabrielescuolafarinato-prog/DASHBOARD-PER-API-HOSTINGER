import { eq } from "drizzle-orm";
import { PageHeading } from "@/components/ui";
import { getDb } from "@/db";
import { sites } from "@/db/schema";
import { requireDashboardSession } from "@/lib/auth/session";
import { getNodeRestartCooldownSeconds } from "@/lib/hostinger/operation-store";
import { BuildsList } from "./builds-list";
import { NodeServerOperations } from "./node-server-operations";

export const metadata = { title: "Node.js builds" };
export const dynamic = "force-dynamic";

export default async function BuildsPage() {
  const current = await requireDashboardSession();
  const [site] = await getDb()
    .select({ nodeEnabled: sites.nodeEnabled })
    .from(sites)
    .where(eq(sites.id, current.site.siteId))
    .limit(1);
  const initialCooldownSeconds = await getNodeRestartCooldownSeconds(
    current.site.siteId,
  );
  return (
    <>
      <PageHeading
        eyebrow="Site-scoped Node.js"
        title="Node.js builds"
        description="Build visibility and controlled server operations for the configured site. Hostinger identity is always resolved from the authoritative site record."
      />
      <NodeServerOperations
        nodeEnabled={site?.nodeEnabled === true}
        initialCooldownSeconds={initialCooldownSeconds}
      />
      <BuildsList />
    </>
  );
}
