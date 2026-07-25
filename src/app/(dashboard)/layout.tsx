import { Sidebar } from "@/components/sidebar";
import { DashboardHeader } from "@/components/dashboard-header";
import { requireDashboardSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const current = await requireDashboardSession();
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
