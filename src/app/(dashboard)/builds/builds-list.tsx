"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, RefreshCw } from "lucide-react";
import { Badge, Card, secondaryButtonClass } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import type {
  NodeBuildPage,
  NodeBuildState,
} from "@/lib/hostinger/client";
import { NODE_RESTARTED_EVENT } from "./restart-submission-guard";

type ApiResult =
  | { ok: true; data: NodeBuildPage }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryAfterSeconds?: number;
        referenceId?: string;
      };
    };

export function BuildsList() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<NodeBuildPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (targetPage: number) => {
    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/builds?page=${targetPage}&per_page=25`,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: activeController.signal,
        },
      );
      const body = (await response.json()) as ApiResult;
      if (!response.ok || !body.ok) {
        throw new Error(
          body.ok
            ? "Builds could not be loaded."
            : [
                body.error.message,
                body.error.referenceId
                  ? `Reference: ${body.error.referenceId}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" "),
        );
      }
      setResult(body.data);
      setPage(body.data.pagination.page);
    } catch (loadError) {
      if (
        loadError instanceof DOMException &&
        loadError.name === "AbortError"
      ) {
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Builds could not be loaded.",
      );
    } finally {
      if (controller.current === activeController) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const kickoff = setTimeout(() => void load(1), 0);
    return () => {
      clearTimeout(kickoff);
      controller.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const refreshAfterRestart = () => void load(page);
    window.addEventListener(NODE_RESTARTED_EVENT, refreshAfterRestart);
    return () => {
      window.removeEventListener(
        NODE_RESTARTED_EVENT,
        refreshAfterRestart,
      );
    };
  }, [load, page]);

  return (
    <Card className="overflow-hidden p-0" aria-busy={loading}>
      <div className="flex items-center justify-between gap-4 border-b border-slate-100 p-5">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Build history</h2>
          <p className="mt-1 text-xs text-slate-500">
            {result
              ? `${result.pagination.total} build${result.pagination.total === 1 ? "" : "s"}`
              : "Validated data from Hostinger"}
          </p>
        </div>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={loading}
          onClick={() => void load(page)}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading && !result ? (
        <BuildLoading />
      ) : error ? (
        <div className="p-10 text-center" role="alert">
          <p className="text-sm font-semibold text-red-700">
            Builds are temporarily unavailable
          </p>
          <p className="mt-2 text-xs text-slate-500">{error}</p>
          <button
            type="button"
            className={`${secondaryButtonClass} mt-5`}
            onClick={() => void load(page)}
          >
            Try again
          </button>
        </div>
      ) : result && result.builds.length === 0 ? (
        <div className="p-12 text-center">
          <FileText className="mx-auto size-7 text-slate-300" />
          <p className="mt-4 text-sm font-semibold text-slate-700">
            No builds yet
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Hostinger returned an empty build history for this site.
          </p>
        </div>
      ) : result ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3">Build</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Origin</th>
                  <th className="px-5 py-3">Created</th>
                  <th className="px-5 py-3">Updated</th>
                  <th className="px-5 py-3 text-right">Logs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.builds.map((build) => (
                  <tr key={build.uuid}>
                    <td className="px-5 py-4">
                      <code
                        className="text-xs font-semibold text-teal-700"
                        title={build.uuid}
                      >
                        {abbreviateUuid(build.uuid)}
                      </code>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={statusTone(build.state)}>
                        {build.state}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-slate-500">
                      {build.origin ?? "—"}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-500">
                      {formatDate(build.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-500">
                      {formatDate(build.updatedAt)}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Link
                        href={`/builds/${build.uuid}`}
                        className={secondaryButtonClass}
                      >
                        Open logs
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-slate-100 p-5">
            <p className="text-xs text-slate-500">
              Page {result.pagination.page}
              {result.pagination.totalPages > 0
                ? ` of ${result.pagination.totalPages}`
                : ""}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label="Previous page"
                className={secondaryButtonClass}
                disabled={loading || !result.pagination.hasPrevious}
                onClick={() => void load(page - 1)}
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                className={secondaryButtonClass}
                disabled={loading || !result.pagination.hasNext}
                onClick={() => void load(page + 1)}
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function BuildLoading() {
  return (
    <div className="space-y-3 p-5" aria-label="Loading builds">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-14 animate-pulse rounded-xl bg-slate-100"
        />
      ))}
    </div>
  );
}

function abbreviateUuid(uuid: string) {
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

function statusTone(
  state: NodeBuildState,
): "success" | "warning" | "danger" | "info" {
  if (state === "completed") return "success";
  if (state === "failed") return "danger";
  if (state === "running") return "info";
  return "warning";
}
