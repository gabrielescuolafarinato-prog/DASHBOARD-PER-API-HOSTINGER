"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  Badge,
  Card,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import { formatDate } from "@/lib/utils";
import {
  isDiagnosticCode,
  type DiagnosticCode,
} from "@/lib/errors";
import type { SiteDatabaseRecord } from "@/lib/hostinger/database-service";
import {
  claimDatabaseRequest,
  claimDatabaseSubmission,
  releaseDatabaseRequest,
  releaseDatabaseSubmission,
} from "./database-submission-guard";

type PageResult = {
  databases: SiteDatabaseRecord[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  discarded: {
    invalid: number;
    missingDomain: number;
    otherDomain: number;
  };
  lastVerifiedAt: string;
};

type RemoteResult = {
  connections: { databaseId: string; ip: string }[];
  discarded: { otherDatabase: number; unsupported: number };
};

type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryAfterSeconds?: number;
        referenceId?: string;
        diagnosticCode?: string;
      };
    };

type Modal =
  | { type: "create" }
  | { type: "password"; database: SiteDatabaseRecord }
  | { type: "repair"; database: SiteDatabaseRecord }
  | { type: "delete"; database: SiteDatabaseRecord }
  | { type: "remote-add"; database: SiteDatabaseRecord }
  | {
      type: "remote-remove";
      database: SiteDatabaseRecord;
      ip: string;
    };

type Notice =
  | {
      tone: "success";
      message: string;
      referenceId?: string;
      diagnosticCode?: DiagnosticCode;
    }
  | {
      tone: "danger";
      message: string;
      referenceId?: string;
      diagnosticCode?: DiagnosticCode;
    };

type PhpMyAdminLink = {
  databaseId: string;
  href: string;
  referenceId: string;
};

export function DatabasesManager({ domain }: { domain: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResult>();
  const [remote, setRemote] = useState<RemoteResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState<Modal>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [phpMyAdminLink, setPhpMyAdminLink] =
    useState<PhpMyAdminLink>();
  const [phpMyAdminPendingIds, setPhpMyAdminPendingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [nameSuffix, setNameSuffix] = useState("");
  const [userSuffix, setUserSuffix] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [remoteIp, setRemoteIp] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const submissionLock = useRef(false);
  const phpMyAdminRequestLocks = useRef(new Set<string>());
  const idempotencyKey = useRef<string | undefined>(undefined);

  const load = useCallback(async (targetPage: number) => {
    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    setLoading(true);
    setError(undefined);
    try {
      const [databaseResponse, remoteResponse] = await Promise.all([
        fetch(`/api/databases?page=${targetPage}&per_page=25`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: activeController.signal,
        }),
        fetch("/api/databases/remote-connections", {
          credentials: "same-origin",
          cache: "no-store",
          signal: activeController.signal,
        }),
      ]);
      const databaseBody =
        (await databaseResponse.json()) as ApiResult<PageResult>;
      const remoteBody =
        (await remoteResponse.json()) as ApiResult<RemoteResult>;
      if (!databaseResponse.ok || !databaseBody.ok) {
        throw apiResultError(
          databaseBody,
          "Databases could not be loaded.",
        );
      }
      if (!remoteResponse.ok || !remoteBody.ok) {
        throw apiResultError(
          remoteBody,
          "Remote connections could not be loaded.",
        );
      }
      setResult(databaseBody.data);
      setRemote(remoteBody.data);
      setPage(databaseBody.data.pagination.page);
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
          : "Databases could not be loaded.",
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
    if (!phpMyAdminLink) return;
    const databaseId = phpMyAdminLink.databaseId;
    const expiry = setTimeout(() => {
      setPhpMyAdminLink((current) =>
        current?.databaseId === databaseId ? undefined : current,
      );
    }, 60_000);
    return () => clearTimeout(expiry);
  }, [phpMyAdminLink]);

  function openModal(next: Modal) {
    clearForm();
    idempotencyKey.current = undefined;
    setNotice(undefined);
    setModal(next);
  }

  function closeModal() {
    if (pending) return;
    clearForm();
    idempotencyKey.current = undefined;
    setModal(undefined);
  }

  function clearForm() {
    setNameSuffix("");
    setUserSuffix("");
    setPassword("");
    setPasswordConfirmation("");
    setDeleteConfirmation("");
    setRemoteIp("");
  }

  async function submitModal(event: React.FormEvent) {
    event.preventDefault();
    if (!modal || !claimDatabaseSubmission(submissionLock)) return;
    setPending(true);
    setNotice(undefined);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const request = modalRequest(modal, {
        nameSuffix,
        userSuffix,
        password,
        passwordConfirmation,
        deleteConfirmation,
        remoteIp,
      });
      const response = await fetch(request.path, {
        method: request.method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as ApiResult<{
        accepted: true;
        queued?: true;
        synchronized?: boolean;
        reconciled?: boolean;
        referenceId: string;
        idempotencyStatus: "created" | "replayed";
      }>;
      if (modal.type === "create" || modal.type === "password") {
        setPassword("");
        setPasswordConfirmation("");
      }
      if (!response.ok || !body.ok) {
        const failure = body.ok ? undefined : body.error;
        setNotice({
          tone: "danger",
          message:
            failure?.message ?? "The operation could not be completed.",
          referenceId: failure?.referenceId,
          diagnosticCode: isDiagnosticCode(failure?.diagnosticCode)
            ? failure.diagnosticCode
            : undefined,
        });
        return;
      }
      clearForm();
      idempotencyKey.current = undefined;
      setModal(undefined);
      setNotice({
        tone: "success",
        message: successMessage(modal, body.data),
        referenceId: body.data.referenceId,
      });
      await load(
        modal.type === "delete" && result?.databases.length === 1
          ? Math.max(1, page - 1)
          : page,
      );
    } catch {
      setPassword("");
      setPasswordConfirmation("");
      setNotice({
        tone: "danger",
        message:
          "The result could not be confirmed. Retry only with the same open dialog.",
      });
    } finally {
      setPending(false);
      releaseDatabaseSubmission(submissionLock);
    }
  }

  async function requestPhpMyAdminLink(
    database: SiteDatabaseRecord,
  ) {
    if (
      !claimDatabaseRequest(
        phpMyAdminRequestLocks.current,
        database.id,
      )
    ) {
      return;
    }
    setPhpMyAdminPendingIds((current) => {
      const next = new Set(current);
      next.add(database.id);
      return next;
    });
    setPhpMyAdminLink((current) =>
      current?.databaseId === database.id ? undefined : current,
    );
    setNotice(undefined);
    try {
      const response = await fetch(
        `/api/databases/${database.id}/phpmyadmin`,
        {
          credentials: "same-origin",
          cache: "no-store",
        },
      );
      const body = (await response.json()) as ApiResult<{
        link: string;
        referenceId: string;
      }>;
      if (!response.ok || !body.ok) {
        const failure = body.ok ? undefined : body.error;
        setNotice({
          tone: "danger",
          message:
            failure?.message ??
            "The phpMyAdmin link could not be generated.",
          referenceId: failure?.referenceId,
          diagnosticCode: isDiagnosticCode(
            failure?.diagnosticCode,
          )
            ? failure.diagnosticCode
            : undefined,
        });
        return;
      }
      if (
        typeof body.data.link !== "string" ||
        body.data.link.length === 0 ||
        typeof body.data.referenceId !== "string"
      ) {
        setNotice({
          tone: "danger",
          message:
            "Hostinger returned an invalid phpMyAdmin link response.",
          diagnosticCode: "PHPMYADMIN_RESPONSE_SHAPE",
        });
        return;
      }
      // The same-origin application endpoint returns this value only after
      // the authenticated Hostinger client validates the temporary URL.
      setPhpMyAdminLink({
        databaseId: database.id,
        href: body.data.link,
        referenceId: body.data.referenceId,
      });
      setNotice({
        tone: "success",
        message:
          "Secure link ready. Use Open phpMyAdmin within 60 seconds.",
        referenceId: body.data.referenceId,
      });
    } catch {
      setNotice({
        tone: "danger",
        message: "The phpMyAdmin link could not be generated.",
      });
    } finally {
      releaseDatabaseRequest(
        phpMyAdminRequestLocks.current,
        database.id,
      );
      setPhpMyAdminPendingIds((current) => {
        const next = new Set(current);
        next.delete(database.id);
        return next;
      });
    }
  }

  function consumePhpMyAdminLink(databaseId: string) {
    setTimeout(() => {
      setPhpMyAdminLink((current) =>
        current?.databaseId === databaseId ? undefined : current,
      );
      setNotice(undefined);
    }, 0);
  }

  const filteredCount = result
    ? result.discarded.invalid +
      result.discarded.missingDomain +
      result.discarded.otherDomain
    : 0;
  const remoteDiscarded = remote
    ? remote.discarded.otherDatabase + remote.discarded.unsupported
    : 0;

  return (
    <>
      <Card className="overflow-hidden p-0" aria-busy={loading}>
        <div className="flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              Database del sito
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {result
                ? `${result.pagination.total} assigned to ${domain} · verified ${formatDate(result.lastVerifiedAt)}`
                : `Live-verified for ${domain}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={loading}
              onClick={() => void load(page)}
            >
              <RefreshCw
                className={`size-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => openModal({ type: "create" })}
            >
              <Plus className="size-4" />
              Create database
            </button>
          </div>
        </div>

        {notice ? <NoticeBox notice={notice} /> : null}
        {filteredCount > 0 || remoteDiscarded > 0 ? (
          <div
            className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-800"
            role="status"
          >
            {filteredCount + remoteDiscarded} account-level or invalid{" "}
            {filteredCount + remoteDiscarded === 1 ? "record was" : "records were"}{" "}
            excluded by the site boundary.
          </div>
        ) : null}

        {loading && !result ? (
          <LoadingRows />
        ) : error ? (
          <div className="p-10 text-center" role="alert">
            <AlertTriangle className="mx-auto size-7 text-red-400" />
            <p className="mt-4 text-sm font-semibold text-red-700">
              Databases are temporarily unavailable
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
        ) : result?.databases.length === 0 ? (
          <div className="p-12 text-center">
            <Database className="mx-auto size-8 text-slate-300" />
            <p className="mt-4 text-sm font-semibold text-slate-700">
              No databases assigned to this site
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Hostinger returned no database for the configured domain.
            </p>
          </div>
        ) : result ? (
          <>
            <div className="divide-y divide-slate-100">
              {result.databases.map((database) => {
                const connections =
                  remote?.connections.filter(
                    (item) => item.databaseId === database.id,
                  ) ?? [];
                return (
                  <DatabaseRow
                    key={database.id}
                    database={database}
                    connections={connections}
                    onAction={openModal}
                    phpMyAdminPending={phpMyAdminPendingIds.has(
                      database.id,
                    )}
                    phpMyAdminLink={
                      phpMyAdminLink?.databaseId === database.id
                        ? phpMyAdminLink
                        : undefined
                    }
                    onPhpMyAdmin={() =>
                      void requestPhpMyAdminLink(database)
                    }
                    onPhpMyAdminOpened={() =>
                      consumePhpMyAdminLink(database.id)
                    }
                  />
                );
              })}
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

      {modal ? (
        <DatabaseDialog
          modal={modal}
          pending={pending}
          nameSuffix={nameSuffix}
          userSuffix={userSuffix}
          password={password}
          passwordConfirmation={passwordConfirmation}
          deleteConfirmation={deleteConfirmation}
          remoteIp={remoteIp}
          setNameSuffix={setNameSuffix}
          setUserSuffix={setUserSuffix}
          setPassword={setPassword}
          setPasswordConfirmation={setPasswordConfirmation}
          setDeleteConfirmation={setDeleteConfirmation}
          setRemoteIp={setRemoteIp}
          onClose={closeModal}
          onSubmit={submitModal}
        />
      ) : null}
    </>
  );
}

function DatabaseRow({
  database,
  connections,
  onAction,
  phpMyAdminPending,
  phpMyAdminLink,
  onPhpMyAdmin,
  onPhpMyAdminOpened,
}: {
  database: SiteDatabaseRecord;
  connections: { databaseId: string; ip: string }[];
  onAction: (modal: Modal) => void;
  phpMyAdminPending: boolean;
  phpMyAdminLink?: PhpMyAdminLink;
  onPhpMyAdmin: () => void;
  onPhpMyAdminOpened: () => void;
}) {
  const percentage = usagePercentage(database);
  return (
    <article className="p-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all text-sm font-bold text-teal-700">
              {database.name}
            </code>
            <Badge tone="success">Verified</Badge>
          </div>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <DataPoint label="User" value={database.user} />
            <DataPoint label="Assigned domain" value={database.domain} />
            <DataPoint
              label="Used space"
              value={formatMegabytes(database.diskUsageMb)}
            />
            <DataPoint
              label="Maximum space"
              value={formatMegabytes(database.maxSizeMb)}
            />
            <DataPoint
              label="Created"
              value={availableDate(database.createdAt)}
            />
            <DataPoint
              label="Updated"
              value={availableDate(database.updatedAt)}
            />
            <DataPoint
              label="Last verified"
              value={availableDate(database.lastVerifiedAt)}
            />
            <DataPoint
              label="Usage"
              value={
                percentage === undefined
                  ? "Not available"
                  : `${percentage.toFixed(1)}%`
              }
            />
          </div>
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Network className="size-4 text-slate-400" />
              <span className="text-xs font-semibold text-slate-600">
                Remote access
              </span>
              {connections.length === 0 ? (
                <span className="text-xs text-slate-400">No rules</span>
              ) : (
                connections.map((connection) => (
                  <span
                    key={connection.ip}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700"
                  >
                    {connection.ip}
                    <button
                      type="button"
                      className="rounded p-0.5 text-red-600 hover:bg-red-50"
                      aria-label={`Remove remote access for ${connection.ip}`}
                      onClick={() =>
                        onAction({
                          type: "remote-remove",
                          database,
                          ip: connection.ip,
                        })
                      }
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="flex max-w-xl flex-wrap gap-2 xl:justify-end">
          <ActionButton
            icon={Plus}
            label="Remote IP"
            onClick={() => onAction({ type: "remote-add", database })}
          />
          <ActionButton
            icon={ExternalLink}
            label={
              phpMyAdminPending
                ? "Generating link"
                : "phpMyAdmin"
            }
            pending={phpMyAdminPending}
            disabled={phpMyAdminPending}
            onClick={onPhpMyAdmin}
          />
          {phpMyAdminLink ? (
            <a
              className={primaryButtonClass}
              href={phpMyAdminLink.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              onClick={onPhpMyAdminOpened}
            >
              <ExternalLink className="size-4" />
              Open phpMyAdmin
            </a>
          ) : null}
          <ActionButton
            icon={KeyRound}
            label="Password"
            onClick={() => onAction({ type: "password", database })}
          />
          <ActionButton
            icon={Wrench}
            label="Repair"
            onClick={() => onAction({ type: "repair", database })}
          />
          <ActionButton
            icon={Trash2}
            label="Delete"
            danger
            onClick={() => onAction({ type: "delete", database })}
          />
        </div>
      </div>
    </article>
  );
}

function DatabaseDialog(props: {
  modal: Modal;
  pending: boolean;
  nameSuffix: string;
  userSuffix: string;
  password: string;
  passwordConfirmation: string;
  deleteConfirmation: string;
  remoteIp: string;
  setNameSuffix: (value: string) => void;
  setUserSuffix: (value: string) => void;
  setPassword: (value: string) => void;
  setPasswordConfirmation: (value: string) => void;
  setDeleteConfirmation: (value: string) => void;
  setRemoteIp: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const { modal, pending } = props;
  const title = dialogTitle(modal);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="database-dialog-title"
    >
      <form
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
        onSubmit={props.onSubmit}
      >
        <h2
          id="database-dialog-title"
          className="text-lg font-bold text-slate-950"
        >
          {title}
        </h2>
        <DialogDescription modal={modal} />
        <div className="mt-5 space-y-4">
          {modal.type === "create" ? (
            <>
              <TextField
                label="Database name suffix"
                value={props.nameSuffix}
                onChange={props.setNameSuffix}
                pattern="[a-z0-9][a-z0-9_]*"
                autoComplete="off"
              />
              <TextField
                label="Database user suffix"
                value={props.userSuffix}
                onChange={props.setUserSuffix}
                pattern="[a-z0-9][a-z0-9_]*"
                autoComplete="off"
              />
              <PasswordFields {...props} />
            </>
          ) : null}
          {modal.type === "password" ? <PasswordFields {...props} /> : null}
          {modal.type === "delete" ? (
            <TextField
              label={`Type ${modal.database.name} to confirm`}
              value={props.deleteConfirmation}
              onChange={props.setDeleteConfirmation}
              autoComplete="off"
              maxLength={128}
            />
          ) : null}
          {modal.type === "remote-add" ? (
            <TextField
              label="Specific IPv4 or IPv6 address"
              value={props.remoteIp}
              onChange={props.setRemoteIp}
              autoComplete="off"
              maxLength={45}
            />
          ) : null}
        </div>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={pending}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={
              modal.type === "delete" ||
              modal.type === "remote-remove"
                ? `${primaryButtonClass} bg-red-700 hover:bg-red-600`
                : primaryButtonClass
            }
            disabled={pending}
          >
            {pending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : modal.type === "delete" ? (
              <Trash2 className="size-4" />
            ) : modal.type === "repair" ? (
              <Wrench className="size-4" />
            ) : (
              <ShieldAlert className="size-4" />
            )}
            {pending ? "Submitting" : dialogSubmitLabel(modal)}
          </button>
        </div>
      </form>
    </div>
  );
}

function DialogDescription({ modal }: { modal: Modal }) {
  const description =
    modal.type === "create"
      ? "The account prefix and configured website domain are resolved only by the server. Passwords are never stored."
      : modal.type === "password"
        ? "This changes the database user password. Update the application configuration that connects to this database immediately afterward."
        : modal.type === "repair"
          ? "Hostinger performs repair asynchronously. Confirmation means the request was queued, not that repair has finished."
          : modal.type === "delete"
            ? "This permanently deletes the database and its remote connections. This action cannot be undone."
            : modal.type === "remote-add"
              ? "Only one specific IPv4 or IPv6 address is accepted. Hostnames, CIDR, wildcards and % are rejected."
              : `Remove remote access for ${modal.ip} from ${modal.database.name}?`;
  return (
    <p className="mt-3 text-sm leading-6 text-slate-600">
      {description}
    </p>
  );
}

function PasswordFields(props: {
  password: string;
  passwordConfirmation: string;
  setPassword: (value: string) => void;
  setPasswordConfirmation: (value: string) => void;
}) {
  return (
    <>
      <TextField
        label="New password"
        type="password"
        value={props.password}
        onChange={props.setPassword}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
      />
      <TextField
        label="Confirm new password"
        type="password"
        value={props.passwordConfirmation}
        onChange={props.setPasswordConfirmation}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
      />
      <p className="text-xs leading-5 text-slate-500">
        Use 12–128 characters with uppercase, lowercase, number and symbol.
      </p>
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  ...inputProps
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
>) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      <input
        {...inputProps}
        type={type}
        value={value}
        className={inputClass}
        required
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ActionButton({
  icon: Icon,
  label,
  danger,
  disabled,
  pending,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  pending?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${secondaryButtonClass} ${
        danger ? "border-red-200 text-red-700 hover:bg-red-50" : ""
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <Icon className="size-4" />
      )}
      {label}
    </button>
  );
}

function DataPoint({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-slate-400">{label}</p>
      <p className="mt-1 break-all font-semibold text-slate-700">
        {value}
      </p>
    </div>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  return (
    <div
      role={notice.tone === "danger" ? "alert" : "status"}
      className={`border-b px-5 py-4 text-sm ${
        notice.tone === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-red-200 bg-red-50 text-red-800"
      }`}
    >
      <p className="font-semibold">{notice.message}</p>
      {notice.referenceId ? (
        <p className="mt-1 text-xs">Reference: {notice.referenceId}</p>
      ) : null}
      {notice.diagnosticCode ? (
        <p className="mt-1 text-xs">
          Diagnostic: {notice.diagnosticCode}
        </p>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-3 p-5" aria-label="Loading databases">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-28 animate-pulse rounded-xl bg-slate-100"
        />
      ))}
    </div>
  );
}

function modalRequest(
  modal: Modal,
  values: {
    nameSuffix: string;
    userSuffix: string;
    password: string;
    passwordConfirmation: string;
    deleteConfirmation: string;
    remoteIp: string;
  },
) {
  if (modal.type === "create") {
    return {
      path: "/api/databases",
      method: "POST",
      body: {
        nameSuffix: values.nameSuffix,
        userSuffix: values.userSuffix,
        password: values.password,
        passwordConfirmation: values.passwordConfirmation,
      },
    };
  }
  if (modal.type === "password") {
    return {
      path: `/api/databases/${modal.database.id}/change-password`,
      method: "POST",
      body: {
        password: values.password,
        passwordConfirmation: values.passwordConfirmation,
        confirmed: true,
      },
    };
  }
  if (modal.type === "repair") {
    return {
      path: `/api/databases/${modal.database.id}/repair`,
      method: "POST",
      body: { confirmed: true },
    };
  }
  if (modal.type === "delete") {
    return {
      path: `/api/databases/${modal.database.id}`,
      method: "DELETE",
      body: {
        confirmation: values.deleteConfirmation,
        confirmed: true,
      },
    };
  }
  if (modal.type === "remote-add") {
    return {
      path: `/api/databases/${modal.database.id}/remote-connections`,
      method: "POST",
      body: { ip: values.remoteIp, confirmed: true },
    };
  }
  return {
    path: `/api/databases/${modal.database.id}/remote-connections`,
    method: "DELETE",
    body: { ip: modal.ip, confirmed: true },
  };
}

function dialogTitle(modal: Modal) {
  if (modal.type === "create") return "Create Hostinger database";
  if (modal.type === "password") return "Change database password";
  if (modal.type === "repair") return "Queue database repair";
  if (modal.type === "delete") return "Permanently delete database";
  if (modal.type === "remote-add") return "Authorize remote IP";
  return "Remove remote IP";
}

function dialogSubmitLabel(modal: Modal) {
  if (modal.type === "create") return "Create database";
  if (modal.type === "password") return "Confirm password change";
  if (modal.type === "repair") return "Confirm and queue repair";
  if (modal.type === "delete") return "Permanently delete";
  if (modal.type === "remote-add") return "Confirm remote access";
  return "Confirm removal";
}

function successMessage(
  modal: Modal,
  result: {
    queued?: true;
    synchronized?: boolean;
    reconciled?: boolean;
    idempotencyStatus: "created" | "replayed";
  },
) {
  if (result.idempotencyStatus === "replayed") {
    return "This request was already accepted by Hostinger.";
  }
  if (modal.type === "repair" || result.queued) {
    return "Hostinger accepted the repair request and queued asynchronous work.";
  }
  if (modal.type === "password") {
    return "Password changed. Update the application database configuration now.";
  }
  if (modal.type === "create") {
    return result.synchronized
      ? "Database created and reconciled with Hostinger."
      : "Creation accepted. Hostinger has not exposed the new database to read-back yet.";
  }
  if (
    (modal.type === "remote-add" ||
      modal.type === "remote-remove") &&
    result.reconciled === false
  ) {
    return "Hostinger accepted the remote-access change; read-back is still pending.";
  }
  return "Hostinger accepted the database operation.";
}

function apiResultError<T>(
  body: ApiResult<T>,
  fallback: string,
) {
  if (body.ok) return new Error(fallback);
  return new Error(
    [
      body.error.message,
      body.error.referenceId
        ? `Reference: ${body.error.referenceId}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function usagePercentage(database: SiteDatabaseRecord) {
  if (
    database.diskUsageMb === undefined ||
    database.maxSizeMb === undefined ||
    database.maxSizeMb <= 0
  ) {
    return undefined;
  }
  return Math.min(
    100,
    (database.diskUsageMb / database.maxSizeMb) * 100,
  );
}

function formatMegabytes(value?: number) {
  return value === undefined
    ? "Not available"
    : `${value.toLocaleString()} MB`;
}

function availableDate(value?: string) {
  return value ? formatDate(value) : "Not available";
}
