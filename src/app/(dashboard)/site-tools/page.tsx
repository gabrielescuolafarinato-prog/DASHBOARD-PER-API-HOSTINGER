import { PageHeading } from "@/components/ui";
import { requireDashboardSession } from "@/lib/auth/session";
import { getLastCacheRequests } from "@/lib/hostinger/cache-service";
import { CacheManager } from "./cache-manager";

export const metadata = { title: "Site tools" };
export const dynamic = "force-dynamic";

export default async function SiteToolsPage() {
  const current = await requireDashboardSession();
  const lastRequests = await getLastCacheRequests(
    current.site.siteId,
  );
  return (
    <>
      <PageHeading
        eyebrow="Site-scoped Hostinger"
        title="Site tools"
        description="Explicit cache operations for the configured website. Hostinger does not expose an authoritative read endpoint here, so no current-state switch is shown."
      />
      <CacheManager initialLastRequests={lastRequests} />
    </>
  );
}
