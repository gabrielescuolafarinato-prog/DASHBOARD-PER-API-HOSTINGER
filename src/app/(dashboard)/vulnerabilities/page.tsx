import { PageHeading } from "@/components/ui";
import { VulnerabilitiesManager } from "./vulnerabilities-manager";

export const metadata = { title: "Vulnerabilities" };
export const dynamic = "force-dynamic";

export default function VulnerabilitiesPage() {
  return (
    <>
      <PageHeading
        eyebrow="Site-scoped Node.js"
        title="Vulnerabilities"
        description="Validated dependency advisories for the configured Hostinger site. Patching opens a pull request for review; it does not resolve vulnerabilities automatically."
      />
      <VulnerabilitiesManager />
    </>
  );
}
