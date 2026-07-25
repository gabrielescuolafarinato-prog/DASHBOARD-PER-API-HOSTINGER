import { CheckCircle2, LogOut, Settings, ShieldCheck } from "lucide-react";
import { logoutAction } from "@/app/actions";
import { Badge, Card, primaryButtonClass } from "@/components/ui";
import { requireOwnerOnboarding } from "@/lib/auth/session";
import { getApplicationSetupStatus } from "@/lib/env";
import { HostingerOnboarding } from "./hostinger-onboarding";
import { HostingerVariableList } from "./hostinger-variable-list";

export const metadata = { title: "Configurazione iniziale" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const current = await requireOwnerOnboarding();
  const { hostinger } = getApplicationSetupStatus();

  return (
    <main className="grid min-h-screen place-items-center p-6 sm:p-10">
      <section className="w-full max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-slate-900 text-teal-300">
            <Settings className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-bold uppercase tracking-[.16em] text-teal-600">
              Hostinger Site Console
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Primo accesso OWNER
            </p>
          </div>
        </div>

        <Card className="p-7 sm:p-10">
          <Badge tone="warning">Onboarding richiesto</Badge>
          <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-950">
            Configurazione iniziale richiesta
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            L’account OWNER di {current.user.name} è attivo, ma non è ancora
            stato associato alcun sito. La dashboard resterà protetta fino al
            completamento dell’associazione.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5">
              <CheckCircle2
                className="size-5 text-emerald-700"
                aria-hidden="true"
              />
              <p className="mt-4 text-sm font-bold text-emerald-950">
                Account OWNER attivo
              </p>
              <p className="mt-1 text-xs leading-5 text-emerald-800">
                La sessione e il ruolo sono stati verificati dal server.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <ShieldCheck className="size-5 text-slate-700" aria-hidden="true" />
              <p className="mt-4 text-sm font-bold text-slate-950">
                Confine single-site
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Discovery, verifica Node.js e importazione restano vincolati al
                target configurato dal server.
              </p>
            </div>
          </div>

          <HostingerOnboarding configuration={hostinger} />
          {hostinger.status === "unconfigured" ||
          hostinger.status === "incomplete" ? (
            <HostingerVariableList />
          ) : null}

          <form action={logoutAction} className="mt-8 border-t border-slate-100 pt-6">
            <button type="submit" className={primaryButtonClass}>
              <LogOut className="size-4" aria-hidden="true" />
              Logout
            </button>
          </form>
        </Card>
      </section>
    </main>
  );
}
