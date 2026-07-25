"use client";

import { useActionState } from "react";
import { KeyRound } from "lucide-react";
import { changePasswordAction, type ActionState } from "@/app/actions";
import { inputClass, primaryButtonClass } from "@/components/ui";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    changePasswordAction,
    { ok: false },
  );
  return (
    <form action={action} className="mt-7 space-y-4">
      <PasswordField name="currentPassword" label="Current password" autoComplete="current-password" />
      <PasswordField name="newPassword" label="New password" autoComplete="new-password" />
      <PasswordField name="confirmPassword" label="Confirm new password" autoComplete="new-password" />
      <p className="text-xs leading-5 text-slate-500">
        Use at least 12 characters with uppercase, lowercase, a number and a symbol.
      </p>
      {state.message ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{state.message}</p> : null}
      <button disabled={pending} className={`${primaryButtonClass} w-full`}>
        <KeyRound className="size-4" /> {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

function PasswordField({ name, label, autoComplete }: { name: string; label: string; autoComplete: string }) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      <input name={name} type="password" className={inputClass} autoComplete={autoComplete} required />
    </label>
  );
}
