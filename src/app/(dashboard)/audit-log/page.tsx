import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents, user } from "@/db/schema";
import { Badge, Card, PageHeading } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { requireDashboardSession } from "@/lib/auth/session";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  await requireDashboardSession();
  const events = await getDb()
    .select({
      id: auditEvents.id,
      operation: auditEvents.operation,
      targetType: auditEvents.targetType,
      result: auditEvents.result,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(auditEvents)
    .leftJoin(user, eq(auditEvents.actorUserId, user.id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  return (
    <>
      <PageHeading
        eyebrow="Traceability"
        title="Audit log"
        description="Administrative and security-relevant operations. Identifiers are hashed and secret metadata is removed."
      />
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">Time</th>
                <th className="px-5 py-3">Actor</th>
                <th className="px-5 py-3">Operation</th>
                <th className="px-5 py-3">Target</th>
                <th className="px-5 py-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="px-5 py-4 text-xs text-slate-500">{formatDate(event.createdAt)}</td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-800">{event.actorName ?? "System"}</p>
                    <p className="text-xs text-slate-500">{event.actorEmail ?? "—"}</p>
                  </td>
                  <td className="px-5 py-4"><code className="text-xs text-teal-700">{event.operation}</code></td>
                  <td className="px-5 py-4 text-slate-500">{event.targetType}</td>
                  <td className="px-5 py-4"><Badge tone={event.result === "SUCCESS" ? "success" : event.result === "DENIED" ? "warning" : "danger"}>{event.result}</Badge></td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-slate-400">No audit events yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
