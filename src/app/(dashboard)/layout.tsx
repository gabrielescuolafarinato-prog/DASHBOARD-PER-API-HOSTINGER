import { Sidebar } from "@/components/sidebar";
import { DashboardHeader } from "@/components/dashboard-header";
import { requireSession } from "@/lib/auth/session";
import { getApplicationSetupStatus } from "@/lib/env";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!getApplicationSetupStatus().applicationConfigured) {
    redirect("/setup-required");
  }
  const current = await requireSession();
  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="lg:pl-64">
        <DashboardHeader user={current.user} />
        <main className="mx-auto max-w-7xl p-4 sm:p-7 lg:p-9">{children}</main>
      </div>
    </div>
  );
}
