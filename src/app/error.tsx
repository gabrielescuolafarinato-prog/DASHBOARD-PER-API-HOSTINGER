"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { secondaryButtonClass } from "@/components/ui";

export default function ApplicationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-900/5 sm:p-12">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-amber-50 text-amber-700">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </span>
        <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-amber-700">
          Accesso non verificabile
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
          Operazione non disponibile
        </h1>
        <p className="mt-4 text-sm leading-7 text-slate-600">
          Il server non ha potuto verificare in modo sicuro l’accesso al sito.
          Riprova più tardi o contatta l’amministratore.
        </p>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-7`}
          onClick={reset}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Riprova
        </button>
      </section>
    </main>
  );
}
