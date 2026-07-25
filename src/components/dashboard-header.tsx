import { LogOut } from "lucide-react";
import { logoutAction } from "@/app/actions";

export function DashboardHeader({
  user,
}: {
  user: { name: string; email: string; role: "OWNER" | "COLLABORATOR" };
}) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-7 lg:h-20">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-400">Workspace</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-800">Production site</p>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden text-right sm:block">
          <p className="text-sm font-semibold text-slate-800">{user.name}</p>
          <p className="text-xs text-slate-500">{user.role === "OWNER" ? "Owner" : "Collaborator"}</p>
        </div>
        <span className="grid size-9 place-items-center rounded-full bg-teal-100 text-sm font-bold text-teal-800">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <form action={logoutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
          >
            <LogOut className="size-4" />
          </button>
        </form>
      </div>
    </header>
  );
}
