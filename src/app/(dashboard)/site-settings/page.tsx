import { eq } from "drizzle-orm";
import { KeyRound, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { getDb } from "@/db";
import { sites } from "@/db/schema";
import { requireDashboardSession } from "@/lib/auth/session";
import { getHostingerEnv } from "@/lib/env";
import { syncHostingerSiteFormAction } from "@/app/actions";
import { Badge, Card, PageHeading, primaryButtonClass } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Site settings" };
export const dynamic = "force-dynamic";

export default async function SiteSettingsPage() {
  const current = await requireDashboardSession();
  const [site] = await getDb()
    .select({
      name: sites.name,
      domain: sites.primaryDomain,
      username: sites.hostingerUsername,
      orderId: sites.hostingerOrderId,
      nodeEnabled: sites.nodeEnabled,
      status: sites.status,
      lastSyncedAt: sites.lastSyncedAt,
    })
    .from(sites)
    .where(eq(sites.id, current.site.siteId))
    .limit(1);
  const env = getHostingerEnv();
  const configured = Boolean(env.HOSTINGER_API_TOKEN);

  return (
    <>
      <PageHeading
        eyebrow="Owner configuration"
        title="Site settings"
        description="The browser never chooses a domain, username or order ID. These values are resolved from server configuration and persisted bindings."
        action={<Badge tone={site?.status === "VERIFIED" ? "success" : "warning"}>{site?.status ?? "UNCONFIGURED"}</Badge>}
      />
      <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <Card>
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-slate-900 text-teal-300"><Server className="size-4" /></span>
            <div>
              <h2 className="font-bold text-slate-900">Site identity</h2>
              <p className="text-xs text-slate-500">Read-only application boundary</p>
            </div>
          </div>
          <dl className="mt-6 divide-y divide-slate-100 text-sm">
            <Row label="Name" value={site?.name ?? "Not configured"} />
            <Row label="Primary domain" value={site?.domain ?? env.HOSTINGER_SITE_DOMAIN ?? "Not configured"} />
            <Row label="Hosting username" value={site?.username ?? env.HOSTINGER_ACCOUNT_USERNAME ?? "Not configured"} />
            <Row label="Order binding" value={site?.orderId ?? "Not discovered"} />
            <Row label="Node.js" value={site?.nodeEnabled ? "Enabled" : "Not verified"} />
            <Row label="Last synchronization" value={formatDate(site?.lastSyncedAt)} />
          </dl>
        </Card>
        <div className="space-y-5">
          <Card>
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-5 text-teal-600" />
              <div>
                <h2 className="text-sm font-bold text-slate-900">Hostinger credential</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {configured ? "A token is configured in the server environment. Its value is never returned." : "Hostinger not configured. Add the complete variable group on Vercel."}
                </p>
              </div>
            </div>
            <div className="mt-4"><Badge tone={configured ? "success" : "warning"}>{configured ? "Configured" : "Setup needed"}</Badge></div>
          </Card>
          <Card>
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 text-teal-600" />
              <div>
                <h2 className="text-sm font-bold text-slate-900">Exact-match verification</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  The response is post-filtered by normalized exact domain. Other sites are discarded before persistence.
                </p>
              </div>
            </div>
            {current.user.role === "OWNER" ? (
              <form action={syncHostingerSiteFormAction} className="mt-5">
                <button className={primaryButtonClass} disabled={!configured}>
                  <RefreshCw className="size-4" /> Verify configuration
                </button>
              </form>
            ) : (
              <p className="mt-4 text-xs text-slate-400">Owner access is required to synchronize.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-5 py-3.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="max-w-[60%] truncate text-right font-semibold text-slate-800">{value}</dd>
    </div>
  );
}
