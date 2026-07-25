import { Settings } from "lucide-react";

export const metadata = { title: "Configurazione richiesta" };

export default function SetupRequiredPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-900/5 sm:p-12">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-900 text-teal-300">
          <Settings className="size-6" aria-hidden="true" />
        </span>
        <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-teal-600">
          Setup richiesto
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
          Configurazione server richiesta
        </h1>
        <p className="mt-4 text-sm leading-7 text-slate-600">
          Database e autenticazione non sono ancora configurati. L’amministratore
          deve completare la configurazione dell’applicazione su Vercel.
        </p>
      </section>
    </main>
  );
}
