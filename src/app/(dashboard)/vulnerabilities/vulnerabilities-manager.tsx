"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Card,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import type {
  HostingerVulnerability,
} from "@/lib/hostinger/client";
import {
  vulnerabilitySeverities,
  type VulnerabilitySeverity,
} from "@/lib/hostinger/vulnerability-constants";
import { formatDate } from "@/lib/utils";

type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        message: string;
        referenceId?: string;
        retryAfterSeconds?: number;
      };
    };

type PatchResult = {
  accepted: true;
  referenceId: string;
  idempotencyStatus: "created" | "replayed";
  patchedVulnerabilityIds: string[];
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  headBranch?: string;
};

export function VulnerabilitiesManager() {
  const [items, setItems] = useState<HostingerVulnerability[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Set<VulnerabilitySeverity>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    message: string;
    referenceId?: string;
    result?: PatchResult;
  }>();
  const controller = useRef<AbortController | undefined>(undefined);
  const submissionLock = useRef(false);
  const idempotencyKey = useRef<string | undefined>(undefined);

  const load = useCallback(
    async (
      activeFilters: Set<VulnerabilitySeverity>,
      preserveNotice = false,
    ) => {
      controller.current?.abort();
      const activeController = new AbortController();
      controller.current = activeController;
      setLoading(true);
      try {
        const parameters = new URLSearchParams();
        for (const severity of activeFilters) {
          parameters.append("severity", severity);
        }
        const query =
          parameters.size > 0 ? `?${parameters.toString()}` : "";
        const response = await fetch(`/api/vulnerabilities${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: activeController.signal,
        });
        const body = (await response.json()) as ApiResult<{
          vulnerabilities: HostingerVulnerability[];
          referenceId: string;
        }>;
        if (!response.ok || !body.ok) {
          const failure = body.ok ? undefined : body.error;
          throw new Error(
            [
              failure?.message ?? "Vulnerabilities could not be loaded.",
              failure?.referenceId
                ? `Reference: ${failure.referenceId}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
        setItems(body.data.vulnerabilities);
        setSelected(new Set());
        if (!preserveNotice) setNotice(undefined);
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        if (!preserveNotice) {
          setNotice({
            tone: "danger",
            message:
              error instanceof Error
                ? error.message
                : "Vulnerabilities could not be loaded.",
          });
        }
      } finally {
        if (controller.current === activeController) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const kickoff = window.setTimeout(() => void load(filters), 0);
    return () => {
      window.clearTimeout(kickoff);
      controller.current?.abort();
    };
  }, [filters, load]);

  function toggleFilter(severity: VulnerabilitySeverity) {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }

  function toggleSelection(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openPatchDialog() {
    if (selected.size === 0 || pending) return;
    idempotencyKey.current = crypto.randomUUID();
    setConfirming(true);
  }

  async function submitPatch(event: React.FormEvent) {
    event.preventDefault();
    if (submissionLock.current || selected.size === 0) return;
    submissionLock.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/vulnerabilities", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key":
            idempotencyKey.current ?? crypto.randomUUID(),
        },
        body: JSON.stringify({
          vulnerabilityIds: [...selected],
          confirmed: true,
        }),
      });
      const body = (await response.json()) as ApiResult<PatchResult>;
      if (!response.ok || !body.ok) {
        const failure = body.ok ? undefined : body.error;
        setNotice({
          tone: "danger",
          message:
            failure?.message ??
            "The patch pull request could not be requested.",
          referenceId: failure?.referenceId,
        });
        return;
      }
      setConfirming(false);
      setSelected(new Set());
      idempotencyKey.current = undefined;
      setNotice({
        tone: "success",
        message:
          body.data.idempotencyStatus === "replayed"
            ? "This patch request was already accepted."
            : "Hostinger opened a pull request. Review and merge it before considering the vulnerabilities resolved.",
        referenceId: body.data.referenceId,
        result: body.data,
      });
      await load(filters, true);
    } catch {
      setNotice({
        tone: "danger",
        message:
          "The result is ambiguous. Do not retry with a new idempotency key.",
      });
    } finally {
      setPending(false);
      submissionLock.current = false;
    }
  }

  return (
    <>
      <Card className="p-0">
        <div className="flex flex-col gap-4 border-b border-slate-100 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              Dependency advisories
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Scan data may lag behind the latest deployment.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={loading || pending}
              onClick={() => void load(filters)}
            >
              <RefreshCw
                className={`size-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={selected.size === 0 || pending}
              onClick={openPatchDialog}
            >
              <GitPullRequest className="size-4" />
              Patch selected ({selected.size})
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
          {vulnerabilitySeverities.map((severity) => (
            <button
              key={severity}
              type="button"
              aria-pressed={filters.has(severity)}
              className={
                filters.has(severity)
                  ? primaryButtonClass
                  : secondaryButtonClass
              }
              onClick={() => toggleFilter(severity)}
            >
              {severity}
            </button>
          ))}
        </div>
        {notice ? (
          <div
            className={`border-b px-5 py-4 text-sm ${
              notice.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
            role="status"
          >
            <p>
              {notice.message}
              {notice.referenceId
                ? ` Reference: ${notice.referenceId}`
                : ""}
            </p>
            {notice.result?.patchedVulnerabilityIds.length ? (
              <p className="mt-2">
                Included advisories:{" "}
                {notice.result.patchedVulnerabilityIds.join(", ")}
              </p>
            ) : null}
            {notice.result?.headBranch ? (
              <p className="mt-1">
                Branch: <code>{notice.result.headBranch}</code>
              </p>
            ) : null}
            {notice.result?.pullRequestUrl ? (
              <a
                className="mt-2 inline-flex items-center gap-1 font-semibold underline"
                href={notice.result.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open pull request
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <div
            className="grid place-items-center p-14 text-sm text-slate-500"
            aria-label="Loading vulnerabilities"
          >
            <LoaderCircle className="mb-3 size-6 animate-spin" />
            Loading vulnerability scan
          </div>
        ) : items.length === 0 ? (
          <div className="p-14 text-center">
            <ShieldCheck className="mx-auto size-8 text-emerald-500" />
            <p className="mt-4 text-sm font-semibold text-slate-700">
              No vulnerabilities in the latest scan
            </p>
            <p className="mt-1 text-xs text-slate-500">
              This does not guarantee the current deployment is
              vulnerability-free.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map((item) => {
              const selectable =
                item.isPatchable && !item.isPatchingInProgress;
              return (
                <article
                  key={item.id}
                  className="flex gap-4 p-5"
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.id}`}
                    checked={selected.has(item.id)}
                    disabled={!selectable || pending}
                    onChange={() => toggleSelection(item.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-bold text-slate-900">
                        {item.id}
                      </code>
                      <Badge tone={severityTone(item.severity)}>
                        {item.severity}
                      </Badge>
                      <Badge>
                        {item.isDirect ? "Direct" : "Transitive"}
                      </Badge>
                      {item.isPatchingInProgress ? (
                        <Badge tone="warning">PR in progress</Badge>
                      ) : item.isPatchable ? (
                        <Badge tone="success">Patchable</Badge>
                      ) : (
                        <Badge tone="neutral">Manual fix</Badge>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                      <Info label="Package" value={item.packageName} />
                      <Info
                        label="Affected version"
                        value={item.installedVersion}
                      />
                      <Info
                        label="Fix version"
                        value={item.fixVersion ?? "Not available"}
                      />
                      <Info
                        label="CVSS"
                        value={
                          item.cvssScore === undefined
                            ? "Not available"
                            : String(item.cvssScore)
                        }
                      />
                      <Info
                        label="CVE"
                        value={item.cve ?? "Not available"}
                      />
                      <Info
                        label="Published"
                        value={
                          item.publishedAt
                            ? formatDate(item.publishedAt)
                            : "Not available"
                        }
                      />
                    </div>
                    {item.advisoryUrl ? (
                      <a
                        href={item.advisoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 underline"
                      >
                        Advisory
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      {confirming ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="patch-dialog-title"
        >
          <form
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
            onSubmit={submitPatch}
          >
            <h2
              id="patch-dialog-title"
              className="text-lg font-bold text-slate-950"
            >
              Open a vulnerability patch pull request?
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Hostinger will modify package.json and open a GitHub pull
              request for the {selected.size} selected patchable{" "}
              {selected.size === 1 ? "advisory" : "advisories"}. Review and
              merge the pull request yourself; no unselected advisory is
              requested.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={pending}
                onClick={() => setConfirming(false)}
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
                  <GitPullRequest className="size-4" />
                )}
                {pending ? "Submitting" : "Confirm pull request"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-slate-400">{label}</p>
      <p className="mt-0.5 break-all font-semibold text-slate-700">
        {value}
      </p>
    </div>
  );
}

function severityTone(
  severity: VulnerabilitySeverity,
): "neutral" | "warning" | "danger" | "info" {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "moderate") return "warning";
  if (severity === "low") return "info";
  return "neutral";
}
