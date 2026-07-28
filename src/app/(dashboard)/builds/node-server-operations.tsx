"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RotateCw,
  Server,
} from "lucide-react";
import {
  Badge,
  Card,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import {
  claimRestartSubmission,
  NODE_RESTARTED_EVENT,
  releaseRestartSubmission,
} from "./restart-submission-guard";

type RestartApiResult =
  | {
      ok: true;
      data: {
        restarted: true;
        referenceId: string;
        idempotencyStatus: "created" | "replayed";
        cooldownEndsAt: string;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryAfterSeconds?: number;
        referenceId?: string;
      };
    };

type OperationMessage =
  | { type: "success"; message: string; referenceId: string }
  | { type: "error"; message: string; referenceId?: string };

export function NodeServerOperations({
  nodeEnabled,
  initialCooldownSeconds,
}: {
  nodeEnabled: boolean;
  initialCooldownSeconds: number;
}) {
  const router = useRouter();
  const submissionLock = useRef(false);
  const idempotencyKey = useRef<string | undefined>(undefined);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(
    initialCooldownSeconds,
  );
  const [outcome, setOutcome] = useState<OperationMessage>();

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setTimeout(() => {
      setCooldownSeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  async function restart() {
    if (!claimRestartSubmission(submissionLock)) return;
    setPending(true);
    setOutcome(undefined);
    try {
      idempotencyKey.current ??= crypto.randomUUID();
      const response = await fetch("/api/node/restart", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: "{}",
      });
      const body = (await response.json()) as RestartApiResult;
      if (!response.ok || !body.ok) {
        idempotencyKey.current = undefined;
        if (!body.ok && body.error.retryAfterSeconds) {
          setCooldownSeconds(body.error.retryAfterSeconds);
        }
        setOutcome({
          type: "error",
          message: body.ok
            ? "The Node.js server could not be restarted."
            : body.error.message,
          referenceId: body.ok ? undefined : body.error.referenceId,
        });
        return;
      }

      setCooldownSeconds(secondsUntil(body.data.cooldownEndsAt));
      idempotencyKey.current = undefined;
      setOutcome({
        type: "success",
        message:
          body.data.idempotencyStatus === "replayed"
            ? "The previous restart request was already completed."
            : "The Node.js server restart was accepted.",
        referenceId: body.data.referenceId,
      });
      window.dispatchEvent(new Event(NODE_RESTARTED_EVENT));
      router.refresh();
    } catch {
      setOutcome({
        type: "error",
        message:
          "The restart result could not be confirmed. Do not submit repeatedly.",
      });
    } finally {
      setConfirmationOpen(false);
      setPending(false);
      releaseRestartSubmission(submissionLock);
    }
  }

  const disabled =
    !nodeEnabled || pending || cooldownSeconds > 0;

  return (
    <>
      <Card className="mb-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-teal-300">
              <Server className="size-4" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-slate-950">
                  Node.js server operations
                </h2>
                <Badge tone={nodeEnabled ? "success" : "warning"}>
                  {nodeEnabled ? "Node.js active" : "Node.js not verified"}
                </Badge>
              </div>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-500">
                Restart the configured site&apos;s server process. The site may
                be temporarily unavailable while the process starts again.
              </p>
              {cooldownSeconds > 0 ? (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  Restart cooldown: {cooldownSeconds}s
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={disabled}
            onClick={() => setConfirmationOpen(true)}
          >
            {pending ? (
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RotateCw className="size-4" aria-hidden="true" />
            )}
            {pending
              ? "Restarting Node.js server"
              : "Restart Node.js server"}
          </button>
        </div>

        {outcome ? (
          <div
            role={outcome.type === "error" ? "alert" : "status"}
            className={`mt-5 rounded-xl border p-4 text-sm ${
              outcome.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            <div className="flex items-start gap-2">
              {outcome.type === "success" ? (
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <div>
                <p className="font-semibold">{outcome.message}</p>
                {outcome.referenceId ? (
                  <p className="mt-1 text-xs">
                    Reference: {outcome.referenceId}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      {confirmationOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restart-dialog-title"
          aria-describedby="restart-dialog-description"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h2
              id="restart-dialog-title"
              className="text-lg font-bold text-slate-950"
            >
              Confirm Node.js server restart
            </h2>
            <p
              id="restart-dialog-description"
              className="mt-3 text-sm leading-6 text-slate-600"
            >
              The configured site may be temporarily unavailable. This does
              not rebuild or redeploy the application.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={pending}
                onClick={() => setConfirmationOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={pending}
                onClick={() => void restart()}
              >
                {pending ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RotateCw className="size-4" aria-hidden="true" />
                )}
                {pending ? "Restart in progress" : "Confirm restart"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function secondsUntil(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}
