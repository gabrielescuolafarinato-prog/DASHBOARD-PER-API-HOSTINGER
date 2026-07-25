import { desc } from "drizzle-orm";
import { UserRoundCog } from "lucide-react";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { requireDashboardSession } from "@/lib/auth/session";
import { setUserActiveFormAction } from "@/app/actions";
import {
  Badge,
  Card,
  PageHeading,
  secondaryButtonClass,
} from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { CreateCollaboratorForm } from "./create-collaborator-form";

export const metadata = { title: "Team" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const current = await requireDashboardSession();
  const users = await getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt));
  const isOwner = current.user.role === "OWNER";

  return (
    <>
      <PageHeading
        eyebrow="Access management"
        title="Team"
        description="Every active member can operate the site. Only owners can manage accounts and global configuration."
      />
      {isOwner ? (
        <Card className="mb-5">
          <div className="mb-5 flex items-start gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-teal-50 text-teal-700">
              <UserRoundCog className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Add a collaborator</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                A strong temporary password is generated server-side and displayed once.
              </p>
            </div>
          </div>
          <CreateCollaboratorForm />
        </Card>
      ) : null}
      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-sm font-bold text-slate-900">Workspace members</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Member</th>
                <th className="px-5 py-3 font-semibold">Role</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Created</th>
                <th className="px-5 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((member) => (
                <tr key={member.id} className="text-sm">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{member.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{member.email}</p>
                  </td>
                  <td className="px-5 py-4"><Badge tone={member.role === "OWNER" ? "info" : "neutral"}>{member.role}</Badge></td>
                  <td className="px-5 py-4"><Badge tone={member.isActive ? "success" : "danger"}>{member.isActive ? "Active" : "Disabled"}</Badge></td>
                  <td className="px-5 py-4 text-slate-500">{formatDate(member.createdAt)}</td>
                  <td className="px-5 py-4 text-right">
                    {isOwner && member.role !== "OWNER" ? (
                      <form action={setUserActiveFormAction}>
                        <input type="hidden" name="userId" value={member.id} />
                        <input type="hidden" name="active" value={String(!member.isActive)} />
                        <button className={secondaryButtonClass}>
                          {member.isActive ? "Disable" : "Reactivate"}
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
