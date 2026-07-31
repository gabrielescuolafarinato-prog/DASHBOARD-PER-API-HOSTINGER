"use client";

import { useRef, useState } from "react";
import {
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  Snowflake,
  Zap,
} from "lucide-react";
import {
  Card,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import { formatDate } from "@/lib/utils";

type LastRequest = {
  operationType: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  requestedAt: string;
};

type CacheAction =
  | { kind: "clear"; label: "Clear website cache" }
  | { kind: "cache"; enabled: boolean; label: string }
  | { kind: "cacheless"; enabled: boolean; label: string };

type ApiResult =
  | {
      ok: true;
      data: {
        accepted: true;
        referenceId: string;
        idempotencyStatus: "created" | "replayed";
      };
    }
  | {
      ok: false;
      error: {
        message: string;
        referenceId?: string;
        retryAfterSeconds?: number;
      };
    };

export function CacheManager({
  initialLastRequests,
}: {
  initialLastRequests: {
    clear?: LastRequest;
    cache?: LastRequest;
    cacheless?: LastRequest;
  };
}) {
  const [lastRequests, setLastRequests] = useState(initialLastRequests);
  const [action, setAction] = useState<CacheAction>();
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    message: string;
    referenceId?: string;
  }>();
  const submissionLock = useRef(false);
  const idempotencyKey = useRef<string | undefined>(undefined);

  function openAction(next: CacheAction) {
    if (pending || cooldown) return;
    idempotencyKey.current = crypto.randomUUID();
    setNotice(undefined);
    setAction(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!action || submissionLock.current) return;
    submissionLock.current = true;
    setPending(true);
    try {
      const request = actionRequest(action);
      const response = await fetch(request.path, {
        method: request.method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key":
            idempotencyKey.current ?? crypto.randomUUID(),
        },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as ApiResult;
      if (!response.ok || !body.ok) {
        const failure = body.ok ? undefined : body.error;
        setNotice({
          tone: "danger",
          message:
            failure?.message ??
            "The cache operation could not be completed.",
          referenceId: failure?.referenceId,
        });
        return;
      }
      const requestedAt = new Date().toISOString();
      const record = {
        operationType: operationType(action),
        status: "SUCCEEDED" as const,
        requestedAt,
      };
      setLastRequests((current) => ({
        ...current,
        [action.kind === "clear" ? "clear" : action.kind]: record,
      }));
      setNotice({
        tone: "success",
        message:
          body.data.idempotencyStatus === "replayed"
            ? "This cache request was already accepted."
            : `${action.label} was accepted by Hostinger.`,
        referenceId: body.data.referenceId,
      });
      setAction(undefined);
      idempotencyKey.current = undefined;
      setCooldown(true);
      window.setTimeout(() => setCooldown(false), 15_000);
    } catch {
      setNotice({
        tone: "danger",
        message:
          "The result is ambiguous. Do not submit a different cache operation immediately.",
      });
    } finally {
      setPending(false);
      submissionLock.current = false;
    }
  }

  return (
    <>
      {notice ? (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-sm ${
            notice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
          role="status"
        >
          {notice.message}
          {notice.referenceId
            ? ` Reference: ${notice.referenceId}`
            : ""}
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-3">
        <ToolCard
          icon={RefreshCw}
          title="Clear website cache"
          description="Purges all website cache and may also purge Hostinger CDN cache when CDN is enabled."
          lastRequest={lastRequests.clear}
          disabled={pending || cooldown}
          actions={[
            {
              label: "Clear cache",
              onClick: () =>
                openAction({
                  kind: "clear",
                  label: "Clear website cache",
                }),
            },
          ]}
        />
        <ToolCard
          icon={Zap}
          title="Website cache"
          description="Caching improves performance. Disabling it can make the website slower."
          lastRequest={lastRequests.cache}
          disabled={pending || cooldown}
          actions={[
            {
              label: "Enable",
              onClick: () =>
                openAction({
                  kind: "cache",
                  enabled: true,
                  label: "Enable website cache",
                }),
            },
            {
              label: "Disable",
              onClick: () =>
                openAction({
                  kind: "cache",
                  enabled: false,
                  label: "Disable website cache",
                }),
            },
          ]}
        />
        <ToolCard
          icon={Snowflake}
          title="Development / cacheless mode"
          description="Cacheless mode is temporary and intended for active development, testing and debugging."
          lastRequest={lastRequests.cacheless}
          disabled={pending || cooldown}
          actions={[
            {
              label: "Enable",
              onClick: () =>
                openAction({
                  kind: "cacheless",
                  enabled: true,
                  label: "Enable cacheless mode",
                }),
            },
            {
              label: "Disable",
              onClick: () =>
                openAction({
                  kind: "cacheless",
                  enabled: false,
                  label: "Disable cacheless mode",
                }),
            },
          ]}
        />
      </div>
      <p className="mt-4 text-xs text-slate-500">
        “Last dashboard request” is local operation history, not the current
        Hostinger state.
        {cooldown ? " A short safety cooldown is active." : ""}
      </p>

      {action ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cache-dialog-title"
        >
          <form
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            onSubmit={submit}
          >
            <h2
              id="cache-dialog-title"
              className="text-lg font-bold text-slate-950"
            >
              Confirm {action.label.toLowerCase()}
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              This request targets the configured Hostinger site. No path,
              directory, username or domain is accepted from the browser.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={pending}
                onClick={() => setAction(undefined)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={primaryButtonClass}
                disabled={pending}
              >
                {pending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                {pending ? "Submitting" : "Confirm"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ToolCard({
  icon: Icon,
  title,
  description,
  lastRequest,
  disabled,
  actions,
}: {
  icon: typeof Zap;
  title: string;
  description: string;
  lastRequest?: LastRequest;
  disabled: boolean;
  actions: { label: string; onClick: () => void }[];
}) {
  return (
    <Card>
      <Icon className="size-6 text-teal-600" />
      <h2 className="mt-4 text-base font-bold text-slate-900">{title}</h2>
      <p className="mt-2 min-h-16 text-sm leading-6 text-slate-600">
        {description}
      </p>
      <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <p className="font-semibold">Last dashboard request</p>
        {lastRequest ? (
          <p className="mt-1">
            {humanOperation(lastRequest.operationType)} ·{" "}
            {formatDate(lastRequest.requestedAt)} ·{" "}
            {humanStatus(lastRequest.status)}
          </p>
        ) : (
          <p className="mt-1">No request recorded.</p>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {actions.map((item) => (
          <button
            key={item.label}
            type="button"
            className={secondaryButtonClass}
            disabled={disabled}
            onClick={item.onClick}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

function actionRequest(action: CacheAction) {
  if (action.kind === "clear") {
    return {
      path: "/api/cache/clear",
      method: "DELETE",
      body: { confirmed: true },
    };
  }
  return {
    path:
      action.kind === "cache"
        ? "/api/cache/toggle"
        : "/api/cacheless/toggle",
    method: "PATCH",
    body: { enabled: action.enabled, confirmed: true },
  };
}

function operationType(action: CacheAction) {
  if (action.kind === "clear") return "site.cache.clear";
  if (action.kind === "cache") {
    return action.enabled ? "site.cache.enable" : "site.cache.disable";
  }
  return action.enabled
    ? "site.cacheless.enable"
    : "site.cacheless.disable";
}

function humanOperation(operationType: string) {
  if (operationType === "site.cache.clear") return "Clear requested";
  if (operationType === "site.cache.enable") return "Enable requested";
  if (operationType === "site.cache.disable") return "Disable requested";
  if (operationType === "site.cacheless.enable")
    return "Enable requested";
  if (operationType === "site.cacheless.disable")
    return "Disable requested";
  return "Request recorded";
}

function humanStatus(status: LastRequest["status"]) {
  if (status === "SUCCEEDED") return "accepted";
  if (status === "IN_PROGRESS") return "in progress";
  return "failed";
}
