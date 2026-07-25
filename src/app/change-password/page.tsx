import { ShieldCheck } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Change password" };
export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const current = await requireSession({ allowPasswordChange: true });
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5 sm:p-9">
        <span className="grid size-11 place-items-center rounded-2xl bg-slate-900 text-teal-300"><ShieldCheck className="size-5" /></span>
        <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-teal-600">Security checkpoint</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">
          {current.user.mustChangePassword ? "Set a private password" : "Change your password"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Temporary credentials must be replaced before entering the dashboard. Other sessions will be revoked.
        </p>
        <ChangePasswordForm />
      </section>
    </main>
  );
}
