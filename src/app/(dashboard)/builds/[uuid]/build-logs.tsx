"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  Badge,
  Card,
  PageHeading,
  secondaryButtonClass,
} from "@/components/ui";
import type { NodeBuildState } from "@/lib/hostinger/client";
import {
  appendLogChunk,
  createSingleFlight,
} from "@/lib/hostinger/log-polling";

type LogsPayload = {
  build: { uuid: string; state: NodeBuildState };
  content: string;
  fromLine: number;
  nextFromLine: number;
  bytes: number;
  truncated: boolean;
  polling: boolean;
};

type ApiResult =
  | { ok: true; data: LogsPayload }
  | { ok: false; error: { code: string; message: string } };

export function BuildLogs({ uuid }: { uuid: string }) {
  const [content, setContent] = useState("");
  const [state, setState] = useState<NodeBuildState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const nextFromLine = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gate = useMemo(() => createSingleFlight<void>(), []);

  const load = useCallback(
    () =>
      gate.run(async () => {
        if (limitReached) return;
        controller.current?.abort();
        const activeController = new AbortController();
        controller.current = activeController;
        setError(undefined);
        try {
          const response = await fetch(
            `/api/builds/${encodeURIComponent(uuid)}/logs?from_line=${nextFromLine.current}`,
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
              body.ok ? "Build logs could not be loaded." : body.error.message,
            );
          }
          nextFromLine.current = body.data.nextFromLine;
          setState(body.data.build.state);
          setPolling(body.data.polling);
          setContent((current) => {
            const appended = appendLogChunk(current, body.data.content);
            if (appended.limitReached) {
              setLimitReached(true);
              setPolling(false);
            }
            return appended.content;
          });
        } catch (loadError) {
          if (
            loadError instanceof DOMException &&
            loadError.name === "AbortError"
          ) {
            return;
          }
          setPolling(false);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Build logs could not be loaded.",
          );
        } finally {
          setLoading(false);
        }
      }),
    [gate, limitReached, uuid],
  );

  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    if (!polling || loading || error || limitReached) return;
    timer.current = setTimeout(() => void load(), 8_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [error, limitReached, load, loading, polling]);

  return (
    <>
      <PageHeading
        eyebrow="Read-only build output"
        title="Build logs"
        description={`Sanitized output for build ${uuid.slice(0, 8)}…${uuid.slice(-4)}. ANSI control sequences and common secret patterns are removed before display.`}
        action={
          <Link href="/builds" className={secondaryButtonClass}>
            <ArrowLeft className="size-4" />
            All builds
          </Link>
        }
      />
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
          <div className="flex items-center gap-3">
            <Badge
              tone={
                state === "completed"
                  ? "success"
                  : state === "failed"
                    ? "danger"
                    : "info"
              }
            >
              {state ?? "loading"}
            </Badge>
            {polling ? (
              <span className="text-xs text-slate-500">
                Live polling every 8 seconds
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={loading || gate.active || limitReached}
            onClick={() => void load()}
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Refresh logs
          </button>
        </div>
        {error ? (
          <div className="p-10 text-center" role="alert">
            <p className="text-sm font-semibold text-red-700">
              Logs are temporarily unavailable
            </p>
            <p className="mt-2 text-xs text-slate-500">{error}</p>
          </div>
        ) : loading && !content ? (
          <div className="space-y-3 p-5" aria-label="Loading build logs">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-4 animate-pulse rounded bg-slate-100"
              />
            ))}
          </div>
        ) : (
          <pre className="max-h-[65vh] min-h-80 overflow-auto whitespace-pre-wrap break-words bg-[#071827] p-5 font-mono text-xs leading-6 text-slate-200">
            {content || "No log output is available for this build."}
          </pre>
        )}
        {limitReached ? (
          <p className="border-t border-amber-100 bg-amber-50 px-5 py-3 text-xs text-amber-800">
            The 512 KiB session display limit was reached. Reload the page to
            start a new bounded log session.
          </p>
        ) : null}
      </Card>
    </>
  );
}
