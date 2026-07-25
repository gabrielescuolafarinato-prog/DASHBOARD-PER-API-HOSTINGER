"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, LoaderCircle, Search, Server } from "lucide-react";
import {
  importHostingerSiteAction,
  verifyHostingerSiteAction,
  type ActionState,
  type HostingerVerificationActionState,
} from "@/app/actions";
import {
  Badge,
  inputClass,
  primaryButtonClass,
} from "@/components/ui";

type PublicHostingerConfiguration =
  | { status: "unconfigured"; configured: false }
  | { status: "incomplete"; configured: false }
  | { status: "invalid"; configured: false }
  | { status: "ready"; configured: true; domain: string };

const initialVerificationState: HostingerVerificationActionState = {
  ok: false,
  status: "idle",
};
const initialImportState: ActionState = { ok: false };

export function HostingerOnboarding({
  configuration,
}: {
  configuration: PublicHostingerConfiguration;
}) {
  const [verification, verifyAction, verificationPending] = useActionState(
    verifyHostingerSiteAction,
    initialVerificationState,
  );
  const [importState, importAction] = useActionState(
    importHostingerSiteAction,
    initialImportState,
  );

  const state = verificationPending
    ? "verifying"
    : verification.status === "verified"
      ? "verified"
      : verification.status === "error"
        ? "error"
        : configuration.status;

  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-teal-300">
            <Server className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-slate-950">
              Collegamento Hostinger
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Il target operativo viene sempre risolto dalla configurazione
              server.
            </p>
          </div>
        </div>
        <ConfigurationBadge state={state} />
      </div>

      {configuration.status === "unconfigured" ? (
        <MissingConfiguration label="Hostinger non configurato" />
      ) : null}

      {configuration.status === "incomplete" ? (
        <MissingConfiguration label="Configurazione incompleta" />
      ) : null}

      {configuration.status === "invalid" ? (
        <ControlledError>
          La configurazione server non è valida. Correggi il gruppo di
          variabili e crea un nuovo deployment.
        </ControlledError>
      ) : null}

      {configuration.configured ? (
        <>
          <dl className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-slate-500">Dominio configurato</dt>
            <dd className="font-semibold text-slate-900">
              {configuration.domain}
            </dd>
          </dl>

          <form action={verifyAction} className="mt-5">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={verificationPending}
            >
              {verificationPending ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Search className="size-4" aria-hidden="true" />
              )}
              {verificationPending
                ? "Verifica in corso"
                : "Verifica sito Hostinger"}
            </button>
          </form>
        </>
      ) : (
        <button
          type="button"
          className={`${primaryButtonClass} mt-5`}
          disabled
        >
          <Search className="size-4" aria-hidden="true" />
          Verifica sito Hostinger
        </button>
      )}

      {verification.status === "error" && verification.message ? (
        <ControlledError>{verification.message}</ControlledError>
      ) : null}

      {verification.status === "verified" && verification.site ? (
        <div className="mt-6 border-t border-slate-200 pt-6">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="size-5" aria-hidden="true" />
            <h3 className="text-sm font-bold">Sito verificato</h3>
          </div>
          <dl className="mt-4 grid gap-x-5 gap-y-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-emerald-800">Dominio</dt>
            <dd className="font-semibold text-emerald-950">
              {verification.site.domain}
            </dd>
            <dt className="text-emerald-800">Stato sito</dt>
            <dd className="font-semibold text-emerald-950">
              {verification.site.siteStatus}
            </dd>
            <dt className="text-emerald-800">Node.js rilevato</dt>
            <dd className="font-semibold text-emerald-950">
              {verification.site.nodeEnabled ? "Sì" : "No"}
            </dd>
            {verification.site.orderId ? (
              <>
                <dt className="text-emerald-800">Order ID</dt>
                <dd className="font-semibold text-emerald-950">
                  {verification.site.orderId}
                </dd>
              </>
            ) : null}
          </dl>

          <form action={importAction} className="mt-5">
            <label
              htmlFor="confirmationDomain"
              className="text-sm font-semibold text-slate-800"
            >
              Digita {configuration.configured
                ? configuration.domain
                : "il dominio configurato"}{" "}
              per confermare
            </label>
            <input
              id="confirmationDomain"
              name="confirmationDomain"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              className={inputClass}
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Prima del salvataggio il server ripeterà discovery e verifica
              Node.js usando soltanto dominio e username server-side.
            </p>
            <ImportButton />
          </form>
          {!importState.ok && importState.message ? (
            <ControlledError>{importState.message}</ControlledError>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConfigurationBadge({ state }: { state: string }) {
  if (state === "verifying") {
    return <Badge tone="info">Verifica in corso</Badge>;
  }
  if (state === "verified") {
    return <Badge tone="success">Sito verificato</Badge>;
  }
  if (state === "ready") {
    return <Badge tone="success">Pronto per la verifica</Badge>;
  }
  if (state === "incomplete") {
    return <Badge tone="warning">Configurazione incompleta</Badge>;
  }
  if (state === "error" || state === "invalid") {
    return <Badge tone="danger">Errore controllato</Badge>;
  }
  return <Badge tone="warning">Hostinger non configurato</Badge>;
}

function MissingConfiguration({ label }: { label: string }) {
  return (
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-950">{label}</p>
      <p className="mt-2 text-xs leading-5 text-amber-900">
        Configura insieme tutte le variabili server richieste. I loro valori
        non vengono mai richiesti dal browser.
      </p>
    </div>
  );
}

function ControlledError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      {children}
    </p>
  );
}

function ImportButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${primaryButtonClass} mt-4`}
      disabled={pending}
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="size-4" aria-hidden="true" />
      )}
      {pending ? "Importazione in corso" : "Conferma e importa sito"}
    </button>
  );
}
