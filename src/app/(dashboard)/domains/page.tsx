import { PageHeading } from "@/components/ui";
import { DomainsManager } from "./domains-manager";

export const metadata = { title: "Domains" };
export const dynamic = "force-dynamic";

export default function DomainsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Authoritative site boundary"
        title="Domains"
        description="Manage the configured site's DNS records, read-only DNS snapshots, subdomains and domain aliases. Every Hostinger target is resolved again on the server."
      />
      <DomainsManager />
    </>
  );
}
