import { eq } from "drizzle-orm";
import {
  Activity,
  CircleGauge,
  Clock3,
  Database,
  Globe2,
  HardDrive,
  RefreshCw,
  Server,
} from "lucide-react";
import { Badge, Card, PageHeading } from "@/components/ui";
import { getDb } from "@/db";
import { sites } from "@/db/schema";
import { requireDashboardSession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { listBuildsForSite } from "@/lib/hostinger/build-service";
import { getDatabaseOverviewForSite } from "@/lib/hostinger/database-service";
import { getNodeRestartCooldownSeconds } from "@/lib/hostinger/operation-store";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const current = await requireDashboardSession();
  const [site] = await getDb()
    .select({
      name: sites.name,
      domain: sites.primaryDomain,
      status: sites.status,
      nodeEnabled: sites.nodeEnabled,
      lastSyncedAt: sites.lastSyncedAt,
    })
    .from(sites)
    .where(eq(sites.id, current.site.siteId))
    .limit(1);

  const [buildOutcome, databaseOutcome, restartOutcome] =
    await Promise.allSettled([
      listBuildsForSite(current, { page: 1, perPage: 25 }),
      getDatabaseOverviewForSite(current),
      getNodeRestartCooldownSeconds(current.site.siteId),
    ]);
  const builds =
    buildOutcome.status === "fulfilled"
      ? buildOutcome.value
      : undefined;
  const databases =
    databaseOutcome.status === "fulfilled"
      ? databaseOutcome.value
      : undefined;
  const restartCooldown =
    restartOutcome.status === "fulfilled"
      ? restartOutcome.value
      : undefined;
  const latestBuild = authoritativeLatestBuild(builds);
  const restartAvailable =
    site?.nodeEnabled === true && restartCooldown === 0;

  const stats = [
    {
      label: "Node.js",
      value: site?.nodeEnabled ? "Active" : "Not available",
      detail: "Configured Hostinger site",
      icon: Server,
      tone: "text-emerald-700 bg-emerald-50",
    },
    {
      label: "Builds",
      value:
        builds?.pagination.total === undefined
          ? "Not available"
          : String(builds.pagination.total),
      detail: "Hostinger build history",
      icon: Activity,
      tone: "text-cyan-700 bg-cyan-50",
    },
    {
      label: "Hostinger databases",
      value:
        databases?.count === undefined
          ? "Not available"
          : String(databases.count),
      detail: "Assigned to this domain",
      icon: Database,
      tone: "text-violet-700 bg-violet-50",
    },
    {
      label: "Restart",
      value:
        restartCooldown === undefined
          ? "Not available"
          : restartAvailable
            ? "Available"
            : restartCooldown > 0
              ? `In ${restartCooldown}s`
              : "Not available",
      detail: "Node.js server operation",
      icon: RefreshCw,
      tone: "text-amber-700 bg-amber-50",
    },
  ];

  return (
    <>
      <PageHeading
        eyebrow="Configured Hostinger site"
        title="Overview"
        description="Live Hostinger data and recently verified bindings for the configured site only."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <div
              className={`grid size-9 place-items-center rounded-xl ${stat.tone}`}
            >
              <stat.icon className="size-4" />
            </div>
            <p className="mt-5 text-2xl font-bold tracking-tight text-slate-950">
              {stat.value}
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-700">
              {stat.label}
            </p>
            <p className="mt-1 text-xs text-slate-400">{stat.detail}</p>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <Card className="p-0">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
            <div>
              <p className="text-sm font-bold text-slate-900">
                Configured site
              </p>
              <p className="mt-1 text-xs text-slate-500">
                The authoritative Hostinger target for every operation.
              </p>
            </div>
            <Badge
              tone={site?.status === "VERIFIED" ? "success" : "warning"}
            >
              {site?.status === "VERIFIED"
                ? "Hostinger verified"
                : "Verification unavailable"}
            </Badge>
          </div>
          <div className="p-5">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-slate-900 text-teal-300">
                <Globe2 className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-slate-950">
                  {site?.name ?? "Not available"}
                </h2>
                <p className="mt-1 break-all text-sm text-slate-500">
                  {site?.domain ?? "Not available"}
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
              <SiteMetric
                icon={Clock3}
                label="Last site verification"
                value={availableDate(site?.lastSyncedAt)}
              />
              <SiteMetric
                icon={Server}
                label="Node.js status"
                value={
                  site?.nodeEnabled ? "Active" : "Not available"
                }
              />
              <SiteMetric
                icon={HardDrive}
                label="Database space used"
                value={formatMegabytes(databases?.diskUsageMb)}
              />
              <SiteMetric
                icon={CircleGauge}
                label="Database space limit"
                value={formatMegabytes(databases?.maxSizeMb)}
              />
              <SiteMetric
                icon={Clock3}
                label="Database synchronization"
                value={availableDate(databases?.lastVerifiedAt)}
              />
              <SiteMetric
                icon={Activity}
                label="Latest build status"
                value={latestBuild?.state ?? "Not available"}
              />
              <SiteMetric
                icon={Clock3}
                label="Latest build date"
                value={availableDate(latestBuild?.createdAt)}
              />
              <SiteMetric
                icon={RefreshCw}
                label="Restart availability"
                value={
                  restartCooldown === undefined
                    ? "Not available"
                    : restartAvailable
                      ? "Available"
                      : restartCooldown > 0
                        ? `Cooldown ${restartCooldown}s`
                        : "Not available"
                }
              />
            </div>
          </div>
        </Card>

        <Card>
          <p className="text-sm font-bold text-slate-900">
            Hostinger checks
          </p>
          <div className="mt-5 space-y-4">
            <StatusRow
              label="Site verification"
              detail={
                site?.status === "VERIFIED"
                  ? `Verified ${availableDate(site.lastSyncedAt)}`
                  : "Not available"
              }
              ok={site?.status === "VERIFIED"}
            />
            <StatusRow
              label="Build data"
              detail={
                builds
                  ? `${builds.pagination.total} builds returned for this site`
                  : errorSummary(buildOutcome)
              }
              ok={Boolean(builds)}
            />
            <StatusRow
              label="Database data"
              detail={
                databases
                  ? `${databases.count} databases verified for this domain`
                  : errorSummary(databaseOutcome)
              }
              ok={Boolean(databases)}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

function SiteMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" />
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-1 font-semibold text-slate-800">{value}</p>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  detail,
  ok,
}: {
  label: string;
  detail: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-1.5 size-2.5 shrink-0 rounded-full ${
          ok ? "bg-emerald-500" : "bg-amber-400"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        <p className="mt-1 break-words text-xs leading-5 text-slate-500">
          {detail}
        </p>
      </div>
      <Badge tone={ok ? "success" : "warning"}>
        {ok ? "Available" : "Check needed"}
      </Badge>
    </div>
  );
}

function availableDate(value?: string | Date | null) {
  return value ? formatDate(value) : "Not available";
}

function formatMegabytes(value?: number) {
  return value === undefined
    ? "Not available"
    : `${value.toLocaleString()} MB`;
}

function errorSummary(
  outcome: PromiseSettledResult<unknown>,
) {
  if (outcome.status === "fulfilled") return "Not available";
  const error = outcome.reason;
  if (!(error instanceof AppError)) return "Not available";
  return [
    error.message,
    error.referenceId ? `Reference: ${error.referenceId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function authoritativeLatestBuild(
  result:
    | Awaited<ReturnType<typeof listBuildsForSite>>
    | undefined,
) {
  if (
    !result ||
    result.pagination.total !== result.builds.length ||
    result.builds.some(
      (build) =>
        !build.createdAt ||
        !Number.isFinite(Date.parse(build.createdAt)),
    )
  ) {
    return undefined;
  }
  return result.builds.reduce<(typeof result.builds)[number] | undefined>(
    (latest, build) =>
      !latest ||
      Date.parse(build.createdAt as string) >
        Date.parse(latest.createdAt as string)
        ? build
        : latest,
    undefined,
  );
}
