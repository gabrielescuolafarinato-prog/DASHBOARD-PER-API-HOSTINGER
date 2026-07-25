"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { inputClass, primaryButtonClass } from "@/components/ui";
import { createSubmissionGate, executeLogin } from "./login-flow";

export function LoginForm() {
  const router = useRouter();
  const submissionGate = useRef(createSubmissionGate());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submissionGate.current.begin()) return;
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const outcome = await executeLogin(
      {
        email: String(form.get("email")),
        password: String(form.get("password")),
      },
      {
        signIn: (input) => authClient.signIn.email(input),
        navigate: (destination) => router.replace(destination),
      },
    );
    if (outcome === "auth_error") {
      setError("Email or password is incorrect, or the account is disabled.");
    } else if (outcome === "unexpected_error") {
      setError("Sign-in could not be completed. Please try again.");
    }
    submissionGate.current.end();
    setPending(false);
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <label className="block text-sm font-semibold text-slate-700">
        Email
        <input
          className={inputClass}
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
      </label>
      <label className="block text-sm font-semibold text-slate-700">
        Password
        <input
          className={inputClass}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button className={`${primaryButtonClass} w-full`} disabled={pending}>
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
