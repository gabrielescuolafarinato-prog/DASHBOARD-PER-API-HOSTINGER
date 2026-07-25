import { ShieldCheck } from "lucide-react";
import { authorizeCurrentSurface } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await authorizeCurrentSurface("login");

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden bg-[#0b2239] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 font-semibold">
          <span className="grid size-10 place-items-center rounded-xl bg-teal-400 text-slate-950">
            <ShieldCheck className="size-5" />
          </span>
          Hostinger Site Console
        </div>
        <div className="max-w-xl pb-14">
          <p className="text-sm font-semibold uppercase tracking-[.2em] text-teal-300">Single-site by design</p>
          <h1 className="mt-5 text-5xl font-bold leading-[1.08] tracking-tight">
            One site. A narrow boundary. No exposed credentials.
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-slate-300">
            Operations are resolved server-side against the configured domain and every administrative change is audited.
          </p>
        </div>
        <p className="text-xs text-slate-400">Private workspace · Public registration disabled</p>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5 sm:p-10">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-slate-900 text-teal-300">
              <ShieldCheck className="size-5" />
            </span>
            <span className="font-semibold text-slate-900">Hostinger Site Console</span>
          </div>
          <p className="text-xs font-bold uppercase tracking-[.17em] text-teal-600">Private access</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Welcome back</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Use the credentials provided by the workspace owner.
          </p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
