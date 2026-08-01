"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Card,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import {
  officialDnsRecordTypes,
  type DnsRecordView,
  type DnsSnapshotDetail,
  type DnsSnapshotSummary,
  type DnsZoneView,
  type DomainAliasView,
  type DomainMutationOutcome,
  type OfficialDnsRecordType,
  type SubdomainView,
} from "@/lib/hostinger/domain-types";
import { formatDate } from "@/lib/utils";

type Tab = "dns" | "snapshots" | "subdomains" | "aliases";
type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { message: string; referenceId?: string; retryAfterSeconds?: number };
    };
type Notice = { tone: "success" | "danger"; message: string; referenceId?: string };

const tabs: { id: Tab; label: string }[] = [
  { id: "dns", label: "DNS records" },
  { id: "snapshots", label: "DNS snapshots" },
  { id: "subdomains", label: "Subdomains" },
  { id: "aliases", label: "Domain aliases" },
];

export function DomainsManager() {
  const [active, setActive] = useState<Tab>("dns");
  return (
    <>
      <div
        className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2"
        role="tablist"
        aria-label="Domain management sections"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? primaryButtonClass : secondaryButtonClass}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active === "dns" ? <DnsRecords /> : null}
      {active === "snapshots" ? <DnsSnapshots /> : null}
      {active === "subdomains" ? <Subdomains /> : null}
      {active === "aliases" ? <Aliases /> : null}
    </>
  );
}

function DnsRecords() {
  const [zone, setZone] = useState<DnsZoneView>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<OfficialDnsRecordType | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const idempotencyKeys = useRef(new Map<string, string>());
  const [action, setAction] = useState<
    | { kind: "ttl"; record: DnsRecordView }
    | { kind: "delete"; record: DnsRecordView }
  >();

  const load = useCallback(async (preserveNotice = false) => {
    setLoading(true);
    try {
      const data = await getJson<DnsZoneView>("/api/domains/dns");
      setZone(data);
      if (!preserveNotice) setNotice(undefined);
    } catch (error) {
      if (!preserveNotice) setNotice(failureNotice(error, "DNS records could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const groups = useMemo(() => {
    const filtered = (zone?.records ?? []).filter((record) => {
      const query = search.trim().toLowerCase();
      return (
        (type === "all" || record.type === type) &&
        (!query || record.name.toLowerCase().includes(query) || record.content.toLowerCase().includes(query))
      );
    });
    return [...Map.groupBy(filtered, (record) => record.groupId).values()];
  }, [search, type, zone]);

  async function mutate(
    key: string,
    method: "POST" | "PUT" | "DELETE",
    body: object,
  ) {
    if (!zone || pending) return;
    setPending(key);
    try {
      const result = await mutation(
        "/api/domains/dns/records",
        method,
        body,
        idempotencyKey(idempotencyKeys.current, key),
      );
      idempotencyKeys.current.delete(key);
      setNotice(appliedNotice(result, "DNS change"));
      setAction(undefined);
      setShowCreate(false);
      await load(true);
    } catch (error) {
      if (!isAmbiguousUiError(error)) idempotencyKeys.current.delete(key);
      setNotice(failureNotice(error, "The DNS change could not be completed."));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <>
      <Card className="mb-5 border-amber-200 bg-amber-50">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" />
          <div className="text-sm leading-6 text-amber-950">
            <p className="font-bold">DNS changes can interrupt the website or email.</p>
            <p>
              A successful request means Hostinger accepted it and the value is visible in the current Hostinger zone. Public DNS propagation is separate and is not verified here.
            </p>
          </div>
        </div>
      </Card>
      <NoticeBox notice={notice} />
      <Card className="p-0">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-5 lg:flex-row lg:items-end">
          <label className="flex-1 text-xs font-semibold text-slate-600">
            Search records
            <input
              className={inputClass}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name or value"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Record type
            <select className={inputClass} value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              <option value="all">All types</option>
              {officialDnsRecordTypes.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <button type="button" className={secondaryButtonClass} disabled={loading || Boolean(pending)} onClick={() => void load()}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button type="button" className={primaryButtonClass} disabled={!zone || Boolean(pending)} onClick={() => setShowCreate(true)}>
            <Plus className="size-4" /> Add record
          </button>
        </div>
        <div className="border-b border-slate-100 px-5 py-3 text-xs text-slate-500">
          {zone ? `Live check: ${formatDate(zone.checkedAt)} · ${zone.records.length} validated values` : "Loading live zone"}
          {zone?.discarded ? ` · ${zone.discarded} unsupported or invalid values hidden` : ""}
        </div>
        {loading && !zone ? <Loading label="Loading DNS zone" /> : groups.length === 0 ? <Empty label="No matching DNS records." /> : (
          <div className="divide-y divide-slate-100">
            {groups.map((records) => {
              const first = records[0];
              return (
                <article key={first.groupId} className="p-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="info">{first.type}</Badge>
                        <code className="break-all text-sm font-bold text-slate-900">{first.name}</code>
                        {first.protected ? <Badge tone="warning">Protected</Badge> : null}
                        {records.some((record) => record.critical) ? <Badge tone="danger">Critical</Badge> : null}
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        TTL {first.ttl ?? "not provided"} · {records.length} {records.length === 1 ? "value" : "values"}
                      </p>
                      {records[0].criticalReason ? <p className="mt-1 text-xs font-semibold text-red-700">{records[0].criticalReason}</p> : null}
                    </div>
                    {!first.protected ? (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={secondaryButtonClass} disabled={Boolean(pending)} onClick={() => setAction({ kind: "ttl", record: first })}>
                          Change TTL
                        </button>
                        <button type="button" className={secondaryButtonClass} disabled={Boolean(pending)} onClick={() => setAction({ kind: "delete", record: first })}>
                          <Trash2 className="size-4" /> Delete group
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-4 space-y-2">
                    {records.map((record) => (
                      <div key={record.id} className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700">
                        <code className="break-all whitespace-pre-wrap">{record.content}</code>
                        {record.priority !== undefined ? <span className="ml-2 text-slate-400">priority {record.priority}</span> : null}
                        {record.isDisabled ? <span className="ml-2 font-semibold text-amber-700">disabled</span> : null}
                      </div>
                    ))}
                  </div>
                  {records.length > 1 && !first.protected ? (
                    <p className="mt-3 text-xs text-slate-500">
                      Hostinger deletes by name and type. Individual value removal is disabled because safe overwrite is forced off; deleting here removes all {records.length} values in this group.
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Card>

      {showCreate && zone ? (
        <CreateDnsDialog
          pending={Boolean(pending)}
          onClose={() => setShowCreate(false)}
          onSubmit={(record, confirmation) => void mutate("create", "POST", { fingerprint: zone.fingerprint, record, confirmation })}
        />
      ) : null}
      {action && zone ? (
        <DnsActionDialog
          action={action}
          pending={Boolean(pending)}
          onClose={() => setAction(undefined)}
          onSubmit={(value) => {
            if (action.kind === "ttl") {
              void mutate(action.record.id, "PUT", {
                fingerprint: zone.fingerprint,
                recordId: action.record.id,
                record: {
                  name: action.record.name,
                  type: action.record.type,
                  content: action.record.content,
                  ttl: Number(value.ttl),
                },
                confirmation: value.confirmation || undefined,
              });
            } else {
              void mutate(action.record.groupId, "DELETE", {
                fingerprint: zone.fingerprint,
                groupId: action.record.groupId,
                mode: "group",
                confirmation: value.confirmation,
              });
            }
          }}
        />
      ) : null}
    </>
  );
}

function CreateDnsDialog({ pending, onClose, onSubmit }: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (record: { name: string; type: OfficialDnsRecordType; content: string; ttl?: number }, confirmation?: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<OfficialDnsRecordType>("A");
  const [content, setContent] = useState("");
  const [ttl, setTtl] = useState("14400");
  const [confirmation, setConfirmation] = useState("");
  return (
    <Dialog title="Add DNS record" onClose={onClose} pending={pending} onSubmit={() => onSubmit({ name, type, content, ttl: ttl ? Number(ttl) : undefined }, confirmation || undefined)}>
      <p className="text-sm leading-6 text-slate-600">Use the apex domain, a relative name or a subordinate FQDN. TXT spacing and quotes are preserved exactly.</p>
      <Field label="Name" value={name} onChange={setName} placeholder="www or example.com" />
      <label className="mt-4 block text-xs font-semibold text-slate-600">Type<select className={inputClass} value={type} onChange={(event) => setType(event.target.value as OfficialDnsRecordType)}>{officialDnsRecordTypes.filter((item) => item !== "SOA" && item !== "NS").map((item) => <option key={item}>{item}</option>)}</select></label>
      <Field label="Value" value={content} onChange={setContent} placeholder={type === "TXT" ? '"v=spf1 ..."' : "Record value"} />
      <Field label="TTL" value={ttl} onChange={setTtl} type="number" />
      <Field label="Strong confirmation (required for critical records)" value={confirmation} onChange={setConfirmation} placeholder="Type the exact record name" required={false} />
    </Dialog>
  );
}

function DnsActionDialog({ action, pending, onClose, onSubmit }: {
  action: { kind: "ttl" | "delete"; record: DnsRecordView };
  pending: boolean;
  onClose: () => void;
  onSubmit: (value: { ttl: string; confirmation: string }) => void;
}) {
  const [ttl, setTtl] = useState(String(action.record.ttl ?? ""));
  const [confirmation, setConfirmation] = useState("");
  const phrase = action.kind === "delete" ? `DELETE ${action.record.name} ${action.record.type}` : action.record.name;
  return (
    <Dialog title={action.kind === "ttl" ? "Change group TTL" : "Delete complete DNS group"} onClose={onClose} pending={pending} onSubmit={() => onSubmit({ ttl, confirmation })}>
      <p className="text-sm leading-6 text-slate-600">
        {action.kind === "ttl" ? "TTL applies to every value with this name and type. Content replacement is intentionally unavailable while overwrite is disabled." : "This removes every value with the same name and type. Public resolvers may continue serving cached values until their TTL expires."}
      </p>
      {action.kind === "ttl" ? <Field label="New TTL" value={ttl} onChange={setTtl} type="number" /> : null}
      {(action.record.critical || action.kind === "delete") ? <Field label={`Type ${phrase} to confirm`} value={confirmation} onChange={setConfirmation} /> : null}
    </Dialog>
  );
}

function DnsSnapshots() {
  const [items, setItems] = useState<DnsSnapshotSummary[]>([]);
  const [detail, setDetail] = useState<DnsSnapshotDetail>();
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getJson<{ snapshots: DnsSnapshotSummary[] }>("/api/domains/dns/snapshots");
      setItems(result.snapshots);
      setNotice(undefined);
    } catch (error) {
      setNotice(failureNotice(error, "DNS snapshots could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function open(id: string) {
    setLoading(true);
    try {
      setDetail(await getJson<DnsSnapshotDetail>(`/api/domains/dns/snapshots/${encodeURIComponent(id)}`));
    } catch (error) {
      setNotice(failureNotice(error, "The DNS snapshot could not be loaded."));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <NoticeBox notice={notice} />
      <Card className="mb-5 border-cyan-200 bg-cyan-50 text-sm leading-6 text-cyan-950">
        Snapshots are read-only in this release. Restore, reset and complete-zone replacement are not available.
      </Card>
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-slate-100 p-4"><h2 className="font-bold">Available snapshots</h2><button type="button" className={secondaryButtonClass} disabled={loading} onClick={() => void load()}><RefreshCw className="size-4" /></button></div>
          {loading && items.length === 0 ? <Loading label="Loading snapshots" /> : items.length === 0 ? <Empty label="No snapshots available." /> : <div className="divide-y divide-slate-100">{items.map((item) => <button key={item.id} type="button" className="w-full p-4 text-left hover:bg-slate-50" onClick={() => void open(item.id)}><span className="block text-sm font-bold">Snapshot {item.id}</span><span className="mt-1 block text-xs text-slate-500">{formatDate(item.createdAt)}</span></button>)}</div>}
        </Card>
        <Card>
          {!detail ? <Empty label="Choose a snapshot to view its validated records." /> : (
            <div>
              <div className="flex flex-wrap items-center gap-2"><Clock3 className="size-5 text-teal-600" /><h2 className="font-bold">Snapshot {detail.id}</h2><Badge>{formatDate(detail.createdAt)}</Badge></div>
              {detail.comparison ? <p className="mt-3 text-sm text-slate-600">Compared with the current Hostinger zone: {detail.comparison.added} added, {detail.comparison.removed} removed, {detail.comparison.unchanged} unchanged values.</p> : <p className="mt-3 text-sm text-slate-500">Current-zone comparison is temporarily unavailable.</p>}
              <div className="mt-5 divide-y divide-slate-100 border-y border-slate-100">{detail.records.map((record) => <div key={record.id} className="py-3 text-xs"><div className="flex gap-2"><Badge tone="info">{record.type}</Badge><code className="break-all font-bold">{record.name}</code></div><code className="mt-2 block break-all whitespace-pre-wrap text-slate-600">{record.content}</code></div>)}</div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Subdomains() {
  const [items, setItems] = useState<SubdomainView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [subdomain, setSubdomain] = useState("");
  const [directory, setDirectory] = useState("");
  const [publicDirectory, setPublicDirectory] = useState(false);
  const [deleting, setDeleting] = useState<SubdomainView>();
  const idempotencyKeys = useRef(new Map<string, string>());
  const load = useCallback(async (preserve = false) => {
    setLoading(true);
    try {
      const result = await getJson<{ subdomains: SubdomainView[] }>("/api/domains/subdomains");
      setItems(result.subdomains);
      if (!preserve) setNotice(undefined);
    } catch (error) { if (!preserve) setNotice(failureNotice(error, "Subdomains could not be loaded.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (pending) return; setPending("create");
    try {
      const result = await mutation("/api/domains/subdomains", "POST", { subdomain, ...(directory ? { directory } : {}), usePublicDirectory: publicDirectory }, idempotencyKey(idempotencyKeys.current, "create"));
      idempotencyKeys.current.delete("create");
      setNotice(appliedNotice(result, "Subdomain")); setSubdomain(""); setDirectory(""); setPublicDirectory(false); await load(true);
    } catch (error) { if (!isAmbiguousUiError(error)) idempotencyKeys.current.delete("create"); setNotice(failureNotice(error, "The subdomain could not be created.")); }
    finally { setPending(undefined); }
  }
  async function remove(confirmation: string) {
    if (!deleting || pending) return; setPending(deleting.id);
    try { const result = await mutation("/api/domains/subdomains", "DELETE", { resourceId: deleting.id, confirmation }, idempotencyKey(idempotencyKeys.current, deleting.id)); idempotencyKeys.current.delete(deleting.id); setNotice(appliedNotice(result, "Subdomain deletion")); setDeleting(undefined); await load(true); }
    catch (error) { if (!isAmbiguousUiError(error)) idempotencyKeys.current.delete(deleting.id); setNotice(failureNotice(error, "The subdomain could not be deleted.")); }
    finally { setPending(undefined); }
  }
  return (
    <>
      <NoticeBox notice={notice} />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
    <Card><h2 className="font-bold">Create subdomain</h2><p className="mt-2 text-sm leading-6 text-slate-600">Enter a label or a hostname below the configured primary domain. Paths are always relative to the site root.</p><form className="mt-4" onSubmit={submit}><Field label="Label or FQDN" value={subdomain} onChange={setSubdomain} placeholder="docs" /><Field label="Relative directory (optional)" value={directory} onChange={setDirectory} placeholder="docs" required={false} /><label className="mt-4 flex gap-2 text-sm text-slate-700"><input type="checkbox" checked={publicDirectory} onChange={(event) => setPublicDirectory(event.target.checked)} disabled={Boolean(directory)} /> Use the website public directory</label><button className={`${primaryButtonClass} mt-5`} disabled={Boolean(pending)}>{pending === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}Create</button></form></Card>
        <ResourceList title="Live subdomains" loading={loading} onRefresh={() => void load()}>{items.length === 0 ? <Empty label="No subdomains found." /> : items.map((item) => <ResourceRow key={item.id} value={item.fqdn} disabled={pending === item.id} onDelete={() => setDeleting(item)} />)}</ResourceList>
      </div>
      {deleting ? <TypedDeleteDialog title="Delete subdomain" value={deleting.fqdn} pending={Boolean(pending)} onClose={() => setDeleting(undefined)} onSubmit={(confirmation) => void remove(confirmation)} /> : null}
    </>
  );
}

function Aliases() {
  const [items, setItems] = useState<DomainAliasView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [alias, setAlias] = useState("");
  const [deleting, setDeleting] = useState<DomainAliasView>();
  const idempotencyKeys = useRef(new Map<string, string>());
  const load = useCallback(async (preserve = false) => { setLoading(true); try { const result = await getJson<{ aliases: DomainAliasView[] }>("/api/domains/aliases"); setItems(result.aliases); if (!preserve) setNotice(undefined); } catch (error) { if (!preserve) setNotice(failureNotice(error, "Domain aliases could not be loaded.")); } finally { setLoading(false); } }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (pending) return; setPending("create"); try { const result = await mutation("/api/domains/aliases", "POST", { alias }, idempotencyKey(idempotencyKeys.current, "create")); idempotencyKeys.current.delete("create"); setNotice(appliedNotice(result, "Domain alias")); setAlias(""); await load(true); } catch (error) { if (!isAmbiguousUiError(error)) idempotencyKeys.current.delete("create"); setNotice(failureNotice(error, "The alias could not be created.")); } finally { setPending(undefined); } }
  async function remove(confirmation: string) { if (!deleting || pending) return; setPending(deleting.id); try { const result = await mutation("/api/domains/aliases", "DELETE", { resourceId: deleting.id, confirmation }, idempotencyKey(idempotencyKeys.current, deleting.id)); idempotencyKeys.current.delete(deleting.id); setNotice(appliedNotice(result, "Alias deletion")); setDeleting(undefined); await load(true); } catch (error) { if (!isAmbiguousUiError(error)) idempotencyKeys.current.delete(deleting.id); setNotice(failureNotice(error, "The alias could not be deleted.")); } finally { setPending(undefined); } }
  return (
    <>
      <NoticeBox notice={notice} />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card><h2 className="font-bold">Add domain alias</h2><p className="mt-1 text-xs text-slate-500">Hostinger calls these parked domains.</p><p className="mt-3 text-sm leading-6 text-slate-600">Enter a hostname only. Ownership is not presented as verified unless Hostinger accepts the configuration.</p><form className="mt-4" onSubmit={submit}><Field label="Alias hostname" value={alias} onChange={setAlias} placeholder="example.net" /><button className={`${primaryButtonClass} mt-5`} disabled={Boolean(pending)}>{pending === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}Add alias</button></form></Card>
        <ResourceList title="Live domain aliases" loading={loading} onRefresh={() => void load()}>{items.length === 0 ? <Empty label="No domain aliases found." /> : items.map((item) => <ResourceRow key={item.id} value={item.hostname} disabled={pending === item.id} onDelete={() => setDeleting(item)} />)}</ResourceList>
      </div>
      {deleting ? <TypedDeleteDialog title="Delete domain alias" value={deleting.hostname} pending={Boolean(pending)} onClose={() => setDeleting(undefined)} onSubmit={(confirmation) => void remove(confirmation)} /> : null}
    </>
  );
}

function Dialog({ title, pending, onClose, onSubmit, children }: { title: string; pending: boolean; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="domain-dialog-title"><form className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><h2 id="domain-dialog-title" className="text-lg font-bold text-slate-950">{title}</h2><div className="mt-3">{children}</div><div className="mt-6 flex justify-end gap-3"><button type="button" className={secondaryButtonClass} disabled={pending} onClick={onClose}>Cancel</button><button className={primaryButtonClass} disabled={pending}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{pending ? "Submitting" : "Confirm"}</button></div></form></div>;
}

function TypedDeleteDialog({ title, value, pending, onClose, onSubmit }: { title: string; value: string; pending: boolean; onClose: () => void; onSubmit: (confirmation: string) => void }) {
  const [confirmation, setConfirmation] = useState("");
  return <Dialog title={title} pending={pending} onClose={onClose} onSubmit={() => onSubmit(confirmation)}><p className="text-sm leading-6 text-slate-600">Type <code className="font-bold">{value}</code> exactly. The server will verify that this resource still exists under the configured site.</p><Field label="Confirmation" value={confirmation} onChange={setConfirmation} /></Dialog>;
}

function Field({ label, value, onChange, placeholder, type = "text", required = true }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; required?: boolean }) {
  return <label className="mt-4 block text-xs font-semibold text-slate-600">{label}<input className={inputClass} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} required={required} /></label>;
}

function ResourceList({ title, loading, onRefresh, children }: { title: string; loading: boolean; onRefresh: () => void; children: React.ReactNode }) {
  return <Card className="p-0"><div className="flex items-center justify-between border-b border-slate-100 p-4"><h2 className="font-bold">{title}</h2><button type="button" className={secondaryButtonClass} disabled={loading} onClick={onRefresh}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />Refresh</button></div><div className="divide-y divide-slate-100">{children}</div></Card>;
}

function ResourceRow({ value, disabled, onDelete }: { value: string; disabled: boolean; onDelete: () => void }) {
  return <div className="flex items-center justify-between gap-4 p-4"><div className="min-w-0"><Globe2 className="mb-2 size-4 text-teal-600" /><code className="break-all text-sm font-bold text-slate-800">{value}</code></div><button type="button" className={secondaryButtonClass} disabled={disabled} onClick={onDelete}><Trash2 className="size-4" />Delete</button></div>;
}

function NoticeBox({ notice }: { notice?: Notice }) {
  return notice ? <div className={`mb-5 rounded-xl border px-4 py-3 text-sm ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`} role="status">{notice.message}{notice.referenceId ? ` Reference: ${notice.referenceId}` : ""}</div> : null;
}

function Loading({ label }: { label: string }) { return <div className="grid place-items-center p-12 text-sm text-slate-500"><LoaderCircle className="mb-3 size-6 animate-spin" />{label}</div>; }
function Empty({ label }: { label: string }) { return <div className="p-10 text-center text-sm text-slate-500">{label}</div>; }

async function getJson<T>(path: string) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  const body = (await response.json()) as ApiResult<T>;
  if (!response.ok || !body.ok) throw apiError(body, "The request failed.", response.status);
  return body.data;
}

async function mutation(path: string, method: string, payload: object, key: string) {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
  } catch {
    throw Object.assign(
      new Error("The result is ambiguous. Retry only with the same open action; do not create a new request."),
      { ambiguous: true },
    );
  }
  let body: ApiResult<DomainMutationOutcome>;
  try {
    body = (await response.json()) as ApiResult<DomainMutationOutcome>;
  } catch {
    throw Object.assign(
      new Error("The result is ambiguous because the server response could not be read. Retry only with the same open action."),
      { ambiguous: true },
    );
  }
  if (!response.ok || !body.ok) throw apiError(body, "The operation failed.", response.status);
  return body.data;
}

function apiError<T>(body: ApiResult<T>, fallback: string, status: number) {
  if (body.ok) return new Error(fallback);
  return Object.assign(new Error(body.error.message || fallback), {
    referenceId: body.error.referenceId,
    ambiguous: [404, 503, 504].includes(status),
  });
}

function failureNotice(error: unknown, fallback: string): Notice {
  return { tone: "danger", message: error instanceof Error ? error.message : fallback, referenceId: typeof error === "object" && error && "referenceId" in error && typeof error.referenceId === "string" ? error.referenceId : undefined };
}

function appliedNotice(result: DomainMutationOutcome, subject: string): Notice {
  return {
    tone: "success",
    message: result.idempotencyStatus === "replayed"
      ? `${subject}: this request was already completed.`
      : `${subject} accepted by Hostinger and visible in the current Hostinger configuration. Public DNS propagation was not checked.`,
    referenceId: result.referenceId,
  };
}

function idempotencyKey(keys: Map<string, string>, resource: string) {
  const existing = keys.get(resource);
  if (existing) return existing;
  const created = crypto.randomUUID();
  keys.set(resource, created);
  return created;
}

function isAmbiguousUiError(error: unknown) {
  return Boolean(error && typeof error === "object" && "ambiguous" in error && error.ambiguous === true);
}
