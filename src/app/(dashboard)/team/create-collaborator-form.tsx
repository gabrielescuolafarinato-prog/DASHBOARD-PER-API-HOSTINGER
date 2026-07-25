"use client";

import { useActionState } from "react";
import { Copy, UserPlus } from "lucide-react";
import {
  createCollaboratorAction,
  type ActionState,
} from "@/app/actions";
import { inputClass, primaryButtonClass } from "@/components/ui";

const initialState: ActionState = { ok: false };

export function CreateCollaboratorForm() {
  const [state, action, pending] = useActionState(createCollaboratorAction, initialState);
  return (
    <div>
      <form action={action} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold text-slate-700">
          Name
          <input name="name" className={inputClass} minLength={2} maxLength={100} required />
        </label>
        <label className="text-sm font-semibold text-slate-700">
          Email
          <input name="email" type="email" className={inputClass} maxLength={254} required />
        </label>
        <div className="sm:col-span-2">
          <button disabled={pending} className={primaryButtonClass}>
            <UserPlus className="size-4" />
            {pending ? "Creating…" : "Create collaborator"}
          </button>
        </div>
      </form>
      {state.message ? (
        <div
          role="status"
          className={`mt-4 rounded-xl p-4 text-sm ${
            state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}
        >
          <p className="font-semibold">{state.message}</p>
          {state.temporaryPassword ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-white p-3">
              <code className="min-w-0 flex-1 break-all text-slate-900">{state.temporaryPassword}</code>
              <button
                type="button"
                className="rounded-lg p-2 hover:bg-slate-100"
                onClick={() => navigator.clipboard.writeText(state.temporaryPassword!)}
                aria-label="Copy temporary password"
              >
                <Copy className="size-4" />
              </button>
            </div>
          ) : null}
          {state.temporaryPassword ? (
            <p className="mt-2 text-xs">This password is only present in this response. It will not be shown again.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
