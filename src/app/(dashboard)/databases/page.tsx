import { PageHeading } from "@/components/ui";
import { requireDashboardSession } from "@/lib/auth/session";
import { DatabasesManager } from "./databases-manager";

export const metadata = { title: "Databases" };
export const dynamic = "force-dynamic";

export default async function DatabasesPage() {
  const current = await requireDashboardSession();
  return (
    <>
      <PageHeading
        eyebrow="Site-scoped Hostinger"
        title="Databases"
        description="Databases and remote-access rules live-verified for the configured domain. Account-wide results are filtered again on the server."
      />
      <DatabasesManager domain={current.site.primaryDomain} />
    </>
  );
}
