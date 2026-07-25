import { count, eq } from "drizzle-orm";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  Globe2,
  ShieldAlert,
  Users,
} from "lucide-react";
import { getDb } from "@/db";
import { sites, user } from "@/db/schema";
import { requireDashboardSession } from "@/lib/auth/session";
import { getHostingerEnv } from "@/lib/env";
import { listCapabilities } from "@/lib/hostinger/capabilities";
import { Badge, Card, PageHeading } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const current = await requireDashboardSession();
  const db = getDb();
  const [site] = await db
    .select({
      id: sites.id,
      name: sites.name,
      domain: sites.primaryDomain,
      status: sites.status,
      lastSyncedAt: sites.lastSyncedAt,
    })
    .from(sites)
    .where(eq(sites.id, current.site.siteId))
    .limit(1);
  const [{ activeUsers }] = await db
    .select({ activeUsers: count() })
    .from(user)
    .where(eq(user.isActive, true));
  const hostinger = getHostingerEnv();
  const capabilities = listCapabilities();
  const planned = capabilities.filter((item) => item.state === "PLANNED").length;
  const implemented = capabilities.filter((item) => item.state === "IMPLEMENTED").length;
  const unavailable = capabilities.filter(
    (item) => item.state === "NOT_AVAILABLE" || item.state === "DENIED",
  ).length;

  const stats = [
    { label: "Active users", value: String(activeUsers), detail: "Across this workspace", icon: Users, tone: "text-cyan-700 bg-cyan-50" },
    { label: "Implemented", value: String(implemented), detail: "Safe backend capabilities", icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50" },
    { label: "Planned", value: String(planned), detail: "Registered, not yet exposed", icon: Activity, tone: "text-amber-700 bg-amber-50" },
    { label: "Denied / unavailable", value: String(unavailable), detail: "Explicit default-deny boundary", icon: ShieldAlert, tone: "text-rose-700 bg-rose-50" },
  ];

  return (
    <>
      <PageHeading
        eyebrow="System snapshot"
        title="Overview"
        description="Connection health, site identity and the current capability boundary at a glance."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <div className={`grid size-9 place-items-center rounded-xl ${stat.tone}`}>
              <stat.icon className="size-4" />
            </div>
            <p className="mt-5 text-3xl font-bold tracking-tight text-slate-950">{stat.value}</p>
            <p className="mt-1 text-sm font-semibold text-slate-700">{stat.label}</p>
            <p className="mt-1 text-xs text-slate-400">{stat.detail}</p>
          </Card>
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-0">
          <div className="border-b border-slate-100 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-slate-900">Configured site</p>
                <p className="mt-1 text-xs text-slate-500">The only Hostinger target visible to this account.</p>
              </div>
              <Badge tone={site?.status === "VERIFIED" ? "success" : "warning"}>
                {site?.status === "VERIFIED" ? "Verified" : "Pending verification"}
              </Badge>
            </div>
          </div>
          <div className="p-5">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-slate-900 text-teal-300">
                <Globe2 className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-bold text-slate-950">{site?.name ?? "No site configured"}</h2>
                <p className="mt-1 text-sm text-slate-500">{site?.domain ?? "Complete the authorized Hostinger site import."}</p>
              </div>
            </div>
            <div className="mt-6 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-2">
              <div className="flex items-center gap-3 text-sm">
                <Database className="size-4 text-emerald-600" />
                <span className="text-slate-500">Neon</span>
                <strong className="ml-auto text-emerald-700">Connected</strong>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Clock3 className="size-4 text-slate-400" />
                <span className="text-slate-500">Last sync</span>
                <strong className="ml-auto text-slate-700">{formatDate(site?.lastSyncedAt)}</strong>
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <p className="text-sm font-bold text-slate-900">Infrastructure status</p>
          <div className="mt-5 space-y-4">
            <StatusRow label="Database" detail="Neon PostgreSQL" ok />
            <StatusRow label="Authentication" detail="Persistent DB sessions" ok />
            <StatusRow
              label="Hostinger API"
              detail={hostinger.HOSTINGER_API_TOKEN ? "Server credential configured" : "Hostinger not configured"}
              ok={Boolean(hostinger.HOSTINGER_API_TOKEN)}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

function StatusRow({ label, detail, ok }: { label: string; detail: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`size-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-400"}`} />
      <div>
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        <p className="text-xs text-slate-500">{detail}</p>
      </div>
      <Badge tone={ok ? "success" : "warning"}>{ok ? "Healthy" : "Setup needed"}</Badge>
    </div>
  );
}
