import { PageHeading } from "@/components/ui";
import { requireDashboardSession } from "@/lib/auth/session";
import { BuildsList } from "./builds-list";

export const metadata = { title: "Node.js builds" };
export const dynamic = "force-dynamic";

export default async function BuildsPage() {
  await requireDashboardSession();
  return (
    <>
      <PageHeading
        eyebrow="Read-only operations"
        title="Node.js builds"
        description="Builds for the configured site. The Hostinger account and domain are always resolved from the authoritative site record."
      />
      <BuildsList />
    </>
  );
}
