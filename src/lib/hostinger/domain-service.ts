import "server-only";

import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { SiteAccessRecord } from "@/lib/authorization/policy";
import { AppError } from "@/lib/errors";
import {
  createHostingerClient,
  type HostingerClient,
  type HostingerDnsZone,
} from "./client";
import {
  dnsPriority,
  normalizeAliasInput,
  normalizeDnsContent,
  normalizeDnsOwnerName,
  normalizeSubdomainDirectory,
  normalizeSubdomainInput,
  parseSnapshotId,
} from "./domain-codec";
import type {
  AliasCreateInput,
  DnsCreateInput,
  DnsDeleteInput,
  DnsUpdateInput,
  ResourceDeleteInput,
  SubdomainCreateInput,
} from "./domain-input";
import type {
  DnsRecordGroup,
  DnsRecordView,
  DomainMutationOutcome,
  OfficialDnsRecordType,
} from "./domain-types";
import {
  claimHostingerOperation,
  finishHostingerOperation,
  type HostingerOperationClaim,
} from "./operation-store";
import {
  createDiagnosticReferenceId,
  reportHostingerOperationDiagnostic,
  type HostingerDiagnosticPhase,
  type HostingerOperationDiagnostic,
} from "./operation-diagnostic";
import {
  assertHostingerSiteAccess,
  type HostingerSiteCapability,
} from "./permissions";

export const DNS_CREATE_OPERATION = "dns.records.create";
export const DNS_UPDATE_OPERATION = "dns.records.update";
export const DNS_DELETE_OPERATION = "dns.records.delete";
export const SUBDOMAIN_CREATE_OPERATION = "subdomains.create";
export const SUBDOMAIN_DELETE_OPERATION = "subdomains.delete";
export const ALIAS_CREATE_OPERATION = "aliases.create";
export const ALIAS_DELETE_OPERATION = "aliases.delete";

type DomainAccessContext = {
  user: { id: string };
  site: SiteAccessRecord;
};

type DomainClient = Pick<
  HostingerClient,
  | "getDnsZone"
  | "validateDnsZoneUpdate"
  | "updateDnsZone"
  | "deleteDnsRecordGroups"
  | "listDnsSnapshots"
  | "getDnsSnapshot"
  | "listSubdomains"
  | "createSubdomain"
  | "deleteSubdomain"
  | "listDomainAliases"
  | "createDomainAlias"
  | "deleteDomainAlias"
>;

type DomainDependencies = {
  client?: DomainClient;
  claimOperation?: typeof claimHostingerOperation;
  finishOperation?: typeof finishHostingerOperation;
  audit?: typeof writeAuditEvent;
  createReferenceId?: () => string;
};

export async function listDnsRecordsForSite(
  current: DomainAccessContext,
  dependencies: DomainDependencies = {},
) {
  assertHostingerSiteAccess(current.site.membershipRole, "dns.records.list");
  const result = await domainRead(
    current,
    "dns.records.list",
    "dns_records_list",
    "dns_zone",
    async (client) =>
      await client.getDnsZone(current.site.primaryDomain),
    dependencies,
  );
  return zoneView(result.groups, current.site.primaryDomain, result.discarded);
}

export async function listDnsSnapshotsForSite(
  current: DomainAccessContext,
  dependencies: DomainDependencies = {},
) {
  assertHostingerSiteAccess(current.site.membershipRole, "dns.snapshots.list");
  const result = await domainRead(
    current,
    "dns.snapshots.list",
    "dns_snapshots_list",
    "dns_snapshot",
    async (client) =>
      await client.listDnsSnapshots(current.site.primaryDomain),
    dependencies,
  );
  return { snapshots: result.snapshots, discarded: result.discarded };
}

export async function getDnsSnapshotForSite(
  current: DomainAccessContext,
  snapshotId: string,
  dependencies: DomainDependencies = {},
) {
  assertHostingerSiteAccess(current.site.membershipRole, "dns.snapshots.view");
  parseSnapshotId(snapshotId);
  const result = await domainRead(
    current,
    "dns.snapshots.view",
    "dns_snapshots_view",
    "dns_snapshot",
    async (client) =>
      await client.getDnsSnapshot(current.site.primaryDomain, snapshotId),
    dependencies,
  );
  const snapshot = zoneView(
    result.groups,
    current.site.primaryDomain,
    result.discarded,
  );
  let comparison: { added: number; removed: number; unchanged: number } | undefined;
  try {
    const currentZone = await (dependencies.client ?? createHostingerClient()).getDnsZone(
      current.site.primaryDomain,
    );
    comparison = compareZones(result.groups, currentZone.groups);
  } catch {
    comparison = undefined;
  }
  return {
    id: result.id,
    createdAt: result.createdAt,
    records: snapshot.records,
    comparison,
  };
}

export async function createDnsRecordForSite(
  current: DomainAccessContext,
  input: DnsCreateInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  const owner = normalizeDnsOwnerName(input.record.name, current.site.primaryDomain);
  const content = normalizeDnsContent(input.record.type, input.record.content);
  assertDnsWritable(owner.fqdn, input.record.type, current.site.primaryDomain);
  requireCriticalConfirmation(
    owner.fqdn,
    input.record.type,
    content,
    input.confirmation,
    current.site.primaryDomain,
  );
  return await executeMutation(
    current,
    {
      capability: "dns.records.create",
      operationType: DNS_CREATE_OPERATION,
      phase: "dns_records_create",
      category: "dns_zone",
      resourceScope: `dns-zone:${current.site.primaryDomain}`,
      targetIdentifier: `dns:${owner.fqdn}:${input.record.type}`,
      dnsRecordType: input.record.type,
      idempotencyKey,
      run: async (client) => {
        const before = await client.getDnsZone(current.site.primaryDomain);
        assertFingerprint(input.fingerprint, before, current.site.primaryDomain);
        if (findExactRecord(before.groups, owner.fqdn, input.record.type, content)) {
          throw new AppError("CONFLICT", "This DNS record already exists.", 409);
        }
        const group: DnsRecordGroup = {
          name: owner.relative,
          fqdn: owner.fqdn,
          type: input.record.type,
          ttl: input.record.ttl,
          records: [{ content, isDisabled: false }],
        };
        await validateUpdate(client, current.site.primaryDomain, [group]);
        return await mutateAndVerify(
          async () => await client.updateDnsZone(current.site.primaryDomain, [group]),
          async () => await client.getDnsZone(current.site.primaryDomain),
          (zone) => Boolean(findExactRecord(zone.groups, owner.fqdn, input.record.type, content)),
          "Hostinger accepted the DNS record, but it is not visible in the current Hostinger zone. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export async function updateDnsRecordForSite(
  current: DomainAccessContext,
  input: DnsUpdateInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  return await executeMutation(
    current,
    {
      capability: "dns.records.update",
      operationType: DNS_UPDATE_OPERATION,
      phase: "dns_records_update",
      category: "dns_zone",
      resourceScope: `dns-zone:${current.site.primaryDomain}`,
      targetIdentifier: `dns-record:${input.recordId}`,
      dnsRecordType: input.record.type,
      idempotencyKey,
      run: async (client) => {
        const before = await client.getDnsZone(current.site.primaryDomain);
        assertFingerprint(input.fingerprint, before, current.site.primaryDomain);
        const view = zoneView(before.groups, current.site.primaryDomain, before.discarded);
        const original = view.records.find((record) => record.id === input.recordId);
        if (!original) throw new AppError("NOT_FOUND", "DNS record not found.", 404);
        assertDnsWritable(original.name, original.type, current.site.primaryDomain);
        const owner = normalizeDnsOwnerName(input.record.name, current.site.primaryDomain);
        const content = normalizeDnsContent(input.record.type, input.record.content);
        if (
          owner.fqdn !== original.name ||
          input.record.type !== original.type ||
          content !== original.content
        ) {
          throw new AppError(
            "VALIDATION_ERROR",
            "The official API cannot safely replace one DNS value while overwrite is disabled. Create the new value, verify it, then remove the complete old group if appropriate.",
            422,
          );
        }
        if (input.record.ttl === undefined || input.record.ttl === original.ttl) {
          throw new AppError("VALIDATION_ERROR", "Choose a different TTL.", 400);
        }
        requireCriticalConfirmation(
          original.name,
          original.type,
          original.content,
          input.confirmation,
          current.site.primaryDomain,
        );
        const group = before.groups.find(
          (candidate) => candidate.fqdn === original.name && candidate.type === original.type,
        );
        if (!group) throw new AppError("NOT_FOUND", "DNS record group not found.", 404);
        const update = { ...group, ttl: input.record.ttl };
        await validateUpdate(client, current.site.primaryDomain, [update]);
        return await mutateAndVerify(
          async () => await client.updateDnsZone(current.site.primaryDomain, [update]),
          async () => await client.getDnsZone(current.site.primaryDomain),
          (zone) => {
            const live = zone.groups.find(
              (candidate) => candidate.fqdn === original.name && candidate.type === original.type,
            );
            return live?.ttl === input.record.ttl;
          },
          "Hostinger accepted the TTL update, but it is not visible in the current Hostinger zone. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export async function deleteDnsRecordForSite(
  current: DomainAccessContext,
  input: DnsDeleteInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  return await executeMutation(
    current,
    {
      capability: "dns.records.delete",
      operationType: DNS_DELETE_OPERATION,
      phase: "dns_records_delete",
      category: "dns_zone",
      resourceScope: `dns-zone:${current.site.primaryDomain}`,
      targetIdentifier: `dns-group:${input.groupId}`,
      idempotencyKey,
      run: async (client) => {
        const before = await client.getDnsZone(current.site.primaryDomain);
        assertFingerprint(input.fingerprint, before, current.site.primaryDomain);
        const view = zoneView(before.groups, current.site.primaryDomain, before.discarded);
        const groupRecords = view.records.filter((record) => record.groupId === input.groupId);
        if (groupRecords.length === 0) {
          throw new AppError("NOT_FOUND", "DNS record group not found.", 404);
        }
        const first = groupRecords[0];
        assertDnsWritable(first.name, first.type, current.site.primaryDomain);
        if (input.mode === "record") {
          const selected = groupRecords.find((record) => record.id === input.recordId);
          if (!selected) throw new AppError("NOT_FOUND", "DNS record not found.", 404);
          if (input.confirmation !== selected.name) {
            throw new AppError("VALIDATION_ERROR", "Type the exact DNS record name to confirm deletion.", 400);
          }
          if (groupRecords.length > 1) {
            throw new AppError(
              "CONFLICT",
              "This group contains multiple values. Hostinger overwrite is disabled, so removing only one value cannot be completed safely by this dashboard.",
              409,
            );
          }
        } else if (input.confirmation !== `DELETE ${first.name} ${first.type}`) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Type DELETE ${first.name} ${first.type} to confirm removal of the complete group.`,
            400,
          );
        }
        return await mutateAndVerify(
          async () =>
            await client.deleteDnsRecordGroups(current.site.primaryDomain, [
              {
                name: before.groups.find(
                  (group) => group.fqdn === first.name && group.type === first.type,
                )?.name ?? first.name,
                type: first.type,
              },
            ]),
          async () => await client.getDnsZone(current.site.primaryDomain),
          (zone) => !zone.groups.some(
            (group) => group.fqdn === first.name && group.type === first.type,
          ),
          "Hostinger accepted the DNS deletion, but the group is still visible. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export async function listSubdomainsForSite(
  current: DomainAccessContext,
  dependencies: DomainDependencies = {},
) {
  assertHostingerSiteAccess(current.site.membershipRole, "subdomains.list");
  const result = await domainRead(
    current,
    "subdomains.list",
    "subdomains_list",
    "subdomain",
    async (client) => await client.listSubdomains(
      current.site.hostingerUsername,
      current.site.primaryDomain,
    ),
    dependencies,
  );
  return {
    subdomains: result.subdomains.map((item) => ({
      id: opaqueId(`subdomain:${item.fqdn}`),
      ...item,
    })),
    discarded: result.discarded,
    checkedAt: new Date().toISOString(),
  };
}

export async function createSubdomainForSite(
  current: DomainAccessContext,
  input: SubdomainCreateInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  const normalized = normalizeSubdomainInput(input.subdomain, current.site.primaryDomain);
  const directory = normalizeSubdomainDirectory(input.directory);
  if (directory && input.usePublicDirectory) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose either a relative directory or the public directory, not both.",
      400,
    );
  }
  return await executeMutation(
    current,
    {
      capability: "subdomains.create",
      operationType: SUBDOMAIN_CREATE_OPERATION,
      phase: "subdomains_create",
      category: "subdomain",
      resourceScope: `subdomain-id:${opaqueId(`subdomain:${normalized.fqdn}`)}`,
      targetIdentifier: `subdomain:${normalized.fqdn}`,
      idempotencyKey,
      run: async (client) => {
        const before = await client.listSubdomains(
          current.site.hostingerUsername,
          current.site.primaryDomain,
        );
        if (before.subdomains.some((item) => item.fqdn === normalized.fqdn)) {
          throw new AppError("CONFLICT", "This subdomain already exists.", 409);
        }
        return await mutateAndVerify(
          async () => await client.createSubdomain(
            current.site.hostingerUsername,
            current.site.primaryDomain,
            {
              subdomain: normalized.label,
              directory,
              isUsingPublicDirectory: input.usePublicDirectory,
            },
          ),
          async () => await client.listSubdomains(
            current.site.hostingerUsername,
            current.site.primaryDomain,
          ),
          (list) => list.subdomains.some((item) => item.fqdn === normalized.fqdn),
          "Hostinger accepted the subdomain, but it is not visible yet. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export async function deleteSubdomainForSite(
  current: DomainAccessContext,
  input: ResourceDeleteInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  return await executeMutation(
    current,
    {
      capability: "subdomains.delete",
      operationType: SUBDOMAIN_DELETE_OPERATION,
      phase: "subdomains_delete",
      category: "subdomain",
      resourceScope: `subdomain-id:${input.resourceId}`,
      targetIdentifier: `subdomain-id:${input.resourceId}`,
      idempotencyKey,
      run: async (client) => {
        const before = await client.listSubdomains(
          current.site.hostingerUsername,
          current.site.primaryDomain,
        );
        const selected = before.subdomains.find(
          (item) => opaqueId(`subdomain:${item.fqdn}`) === input.resourceId,
        );
        if (!selected) throw new AppError("NOT_FOUND", "Subdomain not found.", 404);
        if (input.confirmation !== selected.fqdn) {
          throw new AppError("VALIDATION_ERROR", "Type the exact subdomain to confirm deletion.", 400);
        }
        return await mutateAndVerify(
          async () => await client.deleteSubdomain(
            current.site.hostingerUsername,
            current.site.primaryDomain,
            selected.label,
          ),
          async () => await client.listSubdomains(
            current.site.hostingerUsername,
            current.site.primaryDomain,
          ),
          (list) => !list.subdomains.some((item) => item.fqdn === selected.fqdn),
          "Hostinger accepted the subdomain deletion, but it is still visible. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export async function listAliasesForSite(
  current: DomainAccessContext,
  dependencies: DomainDependencies = {},
) {
  assertHostingerSiteAccess(current.site.membershipRole, "aliases.list");
  const result = await domainRead(
    current,
    "aliases.list",
    "aliases_list",
    "domain_alias",
    async (client) => await client.listDomainAliases(
      current.site.hostingerUsername,
      current.site.primaryDomain,
    ),
    dependencies,
  );
  return {
    aliases: result.aliases.map((hostname) => ({
      id: opaqueId(`alias:${hostname}`),
      hostname,
    })),
    discarded: result.discarded,
    checkedAt: new Date().toISOString(),
  };
}

export async function createAliasForSite(
  current: DomainAccessContext,
  input: AliasCreateInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  const alias = normalizeAliasInput(input.alias, current.site.primaryDomain);
  return await executeMutation(
    current,
    {
      capability: "aliases.create",
      operationType: ALIAS_CREATE_OPERATION,
      phase: "aliases_create",
      category: "domain_alias",
      resourceScope: `alias-id:${opaqueId(`alias:${alias}`)}`,
      targetIdentifier: `alias:${alias}`,
      idempotencyKey,
      run: async (client) => {
        const before = await client.listDomainAliases(
          current.site.hostingerUsername,
          current.site.primaryDomain,
        );
        if (before.aliases.includes(alias)) {
          throw new AppError("CONFLICT", "This domain alias already exists.", 409);
        }
        try {
          return await mutateAndVerify(
            async () => await client.createDomainAlias(
              current.site.hostingerUsername,
              current.site.primaryDomain,
              alias,
            ),
            async () => await client.listDomainAliases(
              current.site.hostingerUsername,
              current.site.primaryDomain,
            ),
            (list) => list.aliases.includes(alias),
            "Hostinger accepted the alias, but it is not visible yet. Do not retry with a new key.",
          );
        } catch (error) {
          if (error instanceof AppError && error.status === 422) {
            throw new AppError(
              "HOSTINGER_ERROR",
              "Hostinger could not confirm ownership or DNS configuration for this alias.",
              422,
              error.correlationId,
            );
          }
          throw error;
        }
      },
    },
    dependencies,
  );
}

export async function deleteAliasForSite(
  current: DomainAccessContext,
  input: ResourceDeleteInput,
  idempotencyKey: string,
  dependencies: DomainDependencies = {},
) {
  return await executeMutation(
    current,
    {
      capability: "aliases.delete",
      operationType: ALIAS_DELETE_OPERATION,
      phase: "aliases_delete",
      category: "domain_alias",
      resourceScope: `alias-id:${input.resourceId}`,
      targetIdentifier: `alias-id:${input.resourceId}`,
      idempotencyKey,
      run: async (client) => {
        const before = await client.listDomainAliases(
          current.site.hostingerUsername,
          current.site.primaryDomain,
        );
        const selected = before.aliases.find(
          (alias) => opaqueId(`alias:${alias}`) === input.resourceId,
        );
        if (!selected) throw new AppError("NOT_FOUND", "Domain alias not found.", 404);
        if (input.confirmation !== selected) {
          throw new AppError("VALIDATION_ERROR", "Type the exact domain alias to confirm deletion.", 400);
        }
        return await mutateAndVerify(
          async () => await client.deleteDomainAlias(
            current.site.hostingerUsername,
            current.site.primaryDomain,
            selected,
          ),
          async () => await client.listDomainAliases(
            current.site.hostingerUsername,
            current.site.primaryDomain,
          ),
          (list) => !list.aliases.includes(selected),
          "Hostinger accepted the alias deletion, but it is still visible. Do not retry with a new key.",
        );
      },
    },
    dependencies,
  );
}

export function zoneView(
  groups: DnsRecordGroup[],
  primaryDomain: string,
  discarded = 0,
) {
  const records: DnsRecordView[] = [];
  for (const group of groups) {
    const groupId = opaqueId(`dns-group:${group.fqdn}:${group.type}`);
    for (const [index, record] of group.records.entries()) {
      const criticalReason = dnsCriticalReason(
        group.fqdn,
        group.type,
        record.content,
        primaryDomain,
      );
      records.push({
        id: opaqueId(
          `dns-record:${group.fqdn}:${group.type}:${group.ttl ?? ""}:${record.content}:${record.isDisabled}:${index}`,
        ),
        groupId,
        name: group.fqdn,
        type: group.type,
        content: record.content,
        ttl: group.ttl,
        priority: dnsPriority(group.type, record.content),
        isDisabled: record.isDisabled,
        protected: isDnsProtected(group.fqdn, group.type, primaryDomain),
        critical: Boolean(criticalReason),
        criticalReason,
      });
    }
  }
  records.sort((left, right) =>
    `${left.name}\0${left.type}\0${left.content}`.localeCompare(
      `${right.name}\0${right.type}\0${right.content}`,
    ),
  );
  return {
    records,
    fingerprint: zoneFingerprint(groups),
    checkedAt: new Date().toISOString(),
    discarded,
    domain: currentDomain(primaryDomain),
  };
}

export function zoneFingerprint(groups: DnsRecordGroup[]) {
  const relevant = groups
    .map((group) => ({
      name: group.name,
      fqdn: group.fqdn,
      type: group.type,
      ttl: group.ttl ?? null,
      records: group.records
        .map((record) => ({ content: record.content, isDisabled: record.isDisabled }))
        .sort((left, right) =>
          `${left.content}\0${left.isDisabled}`.localeCompare(
            `${right.content}\0${right.isDisabled}`,
          ),
        ),
    }))
    .sort((left, right) => `${left.fqdn}\0${left.type}`.localeCompare(`${right.fqdn}\0${right.type}`));
  return hash(JSON.stringify(relevant));
}

function isDnsProtected(name: string, type: OfficialDnsRecordType, primaryDomain: string) {
  return type === "SOA" || (type === "NS" && name === currentDomain(primaryDomain));
}

function assertDnsWritable(name: string, type: OfficialDnsRecordType, primaryDomain: string) {
  if (isDnsProtected(name, type, primaryDomain)) {
    throw new AppError(
      "FORBIDDEN",
      "SOA and authoritative apex nameserver records are protected and read-only.",
      403,
    );
  }
}

function dnsCriticalReason(
  name: string,
  type: OfficialDnsRecordType,
  content: string,
  primaryDomain: string,
) {
  const domain = currentDomain(primaryDomain);
  if ((name === domain || name === `www.${domain}`) && ["A", "AAAA", "CNAME"].includes(type)) {
    return "May interrupt the current website.";
  }
  if (type === "MX") return "May interrupt email delivery.";
  if (type === "TXT" && /^\s*["']?v=spf1\b/i.test(content)) return "SPF email policy record.";
  if (name === `_dmarc.${domain}` || name.startsWith(`_dmarc.`)) return "DMARC email policy record.";
  if (name.includes("._domainkey.")) return "DKIM email authentication record.";
  return undefined;
}

function requireCriticalConfirmation(
  name: string,
  type: OfficialDnsRecordType,
  content: string,
  confirmation: string | undefined,
  primaryDomain: string,
) {
  if (dnsCriticalReason(name, type, content, primaryDomain) && confirmation !== name) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Type the exact DNS record name to confirm this critical change.",
      400,
    );
  }
}

function assertFingerprint(expected: string, zone: HostingerDnsZone, primaryDomain: string) {
  if (expected !== zoneFingerprint(zone.groups)) {
    throw new AppError(
      "CONFLICT",
      "The DNS zone changed after it was displayed. Refresh and review the live zone before trying again.",
      409,
    );
  }
  currentDomain(primaryDomain);
}

async function validateUpdate(client: DomainClient, domain: string, groups: DnsRecordGroup[]) {
  try {
    await client.validateDnsZoneUpdate(domain, groups);
  } catch (error) {
    if (error instanceof AppError && error.status === 422) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Hostinger DNS validation rejected this change. No update was sent.",
        422,
        error.correlationId,
      );
    }
    throw error;
  }
}

async function mutateAndVerify<T>(
  mutate: () => Promise<{ accepted: true; correlationId?: string }>,
  read: () => Promise<T>,
  postcondition: (value: T) => boolean,
  postconditionMessage: string,
) {
  let result: { accepted: true; correlationId?: string };
  try {
    result = await mutate();
  } catch (error) {
    if (!isAmbiguousMutationError(error)) throw error;
    try {
      const reconciled = await read();
      if (postcondition(reconciled)) {
        return {
          correlationId: error instanceof AppError ? error.correlationId : undefined,
          recovered: true,
        };
      }
    } catch {
      // Keep the original ambiguous mutation error and never retry it.
    }
    throw new AppError(
      error instanceof AppError ? error.code : "HOSTINGER_ERROR",
      "The Hostinger mutation result is ambiguous and the read-only reconciliation did not confirm the post-condition. Do not retry with a new idempotency key.",
      error instanceof AppError ? error.status : 503,
      error instanceof AppError ? error.correlationId : undefined,
    );
  }
  let after: T;
  try {
    after = await read();
  } catch {
    throw new AppError(
      "HOSTINGER_ERROR",
      "Hostinger accepted the request, but the post-condition could not be checked. Do not retry with a new idempotency key.",
      503,
      result.correlationId,
    );
  }
  if (!postcondition(after)) {
    throw new AppError(
      "HOSTINGER_ERROR",
      postconditionMessage,
      503,
      result.correlationId,
    );
  }
  return { correlationId: result.correlationId, recovered: false };
}

type MutationDefinition = {
  capability: HostingerSiteCapability;
  operationType: string;
  phase: HostingerDiagnosticPhase;
  category: NonNullable<HostingerOperationDiagnostic["resourceCategory"]>;
  resourceScope: string;
  targetIdentifier: string;
  dnsRecordType?: OfficialDnsRecordType;
  idempotencyKey: string;
  run: (client: DomainClient) => Promise<{ correlationId?: string; recovered: boolean }>;
};

async function executeMutation(
  current: DomainAccessContext,
  definition: MutationDefinition,
  dependencies: DomainDependencies,
): Promise<DomainMutationOutcome> {
  assertHostingerSiteAccess(current.site.membershipRole, definition.capability);
  const referenceId = dependencies.createReferenceId?.() ?? createDiagnosticReferenceId();
  const idempotencyKeyHash = hash(definition.idempotencyKey.toLowerCase());
  const startedAt = Date.now();
  const claim = await (dependencies.claimOperation ?? claimHostingerOperation)({
    siteId: current.site.siteId,
    actorUserId: current.user.id,
    operationType: definition.operationType,
    resourceKeyHash: hash(definition.resourceScope),
    idempotencyKeyHash,
    referenceId,
    cooldownSeconds: 0,
  });
  const audit = dependencies.audit ?? writeAuditEvent;
  if (claim.kind !== "claimed") {
    await auditClaim(current, definition, claim, audit);
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: definition.phase,
      upstreamStatus: claim.kind === "duplicate" && claim.operation.status === "SUCCEEDED" ? 200 : 409,
      operationType: definition.operationType,
      idempotencyStatus: claim.kind === "duplicate" ? "duplicate" : "blocked",
      result: claim.kind === "duplicate" && claim.operation.status === "SUCCEEDED" ? "success" : "denied",
      resourceCategory: definition.category,
      dnsRecordType: definition.dnsRecordType,
      startedAt,
    });
    if (claim.kind === "duplicate" && claim.operation.status === "SUCCEEDED") {
      return {
        accepted: true,
        visibleInHostinger: true,
        referenceId: claim.operation.referenceId,
        idempotencyStatus: "replayed",
      };
    }
    throw new AppError(
      "CONFLICT",
      claim.kind === "blocked"
        ? "Another operation is already in progress for this resource."
        : "This request is already in progress or already failed and will not be sent again.",
      409,
      undefined,
      claim.operation.referenceId,
      claim.operation.status === "IN_PROGRESS" ? 5 : undefined,
    );
  }
  await safeAudit(audit, auditEvent(current, definition, "requested", "SUCCESS", claim.operation.referenceId, "claimed"));
  let result: { correlationId?: string; recovered: boolean };
  try {
    result = await definition.run(dependencies.client ?? createHostingerClient());
  } catch (error) {
    const controlled = controlledDomainError(error, claim.operation.referenceId, current);
    await safeFinish(dependencies.finishOperation ?? finishHostingerOperation, {
      siteId: current.site.siteId,
      operationType: definition.operationType,
      idempotencyKeyHash,
      status: "FAILED",
      correlationId: controlled.correlationId,
    });
    await safeAudit(
      audit,
      auditEvent(current, definition, "failed", controlled.status >= 500 ? "FAILURE" : "DENIED", claim.operation.referenceId, "failed", controlled),
    );
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: definition.phase,
      upstreamStatus: controlled.status,
      correlationId: controlled.correlationId,
      operationType: definition.operationType,
      idempotencyStatus: "failed",
      result: controlled.status >= 500 ? "failure" : "denied",
      resourceCategory: definition.category,
      dnsRecordType: definition.dnsRecordType,
      startedAt,
      forbiddenValues: [current.site.hostingerUsername, current.site.primaryDomain],
    });
    throw controlled;
  }
  const correlationId = safeCorrelationId(result.correlationId, current);
  const finished = await safeFinish(dependencies.finishOperation ?? finishHostingerOperation, {
    siteId: current.site.siteId,
    operationType: definition.operationType,
    idempotencyKeyHash,
    status: "SUCCEEDED",
    correlationId,
  });
  if (!finished) {
    const persistenceError = new AppError(
      "INTERNAL_ERROR",
      "Hostinger accepted the request, but its local result could not be recorded. Do not retry.",
      503,
      correlationId,
      claim.operation.referenceId,
    );
    await safeAudit(
      audit,
      auditEvent(
        current,
        definition,
        "success_persistence_failed",
        "FAILURE",
        claim.operation.referenceId,
        "failed",
        persistenceError,
      ),
    );
    reportHostingerOperationDiagnostic({
      referenceId: claim.operation.referenceId,
      phase: definition.phase,
      upstreamStatus: 503,
      correlationId,
      operationType: definition.operationType,
      idempotencyStatus: "failed",
      result: "failure",
      resourceCategory: definition.category,
      dnsRecordType: definition.dnsRecordType,
      startedAt,
    });
    throw persistenceError;
  }
  await safeAudit(audit, auditEvent(current, definition, result.recovered ? "reconciled" : "completed", "SUCCESS", claim.operation.referenceId, "completed"));
  reportHostingerOperationDiagnostic({
    referenceId: claim.operation.referenceId,
    phase: definition.phase,
    upstreamStatus: result.recovered ? 503 : 200,
    correlationId,
    operationType: definition.operationType,
    idempotencyStatus: "completed",
    result: result.recovered ? "recovered" : "accepted",
    resourceCategory: definition.category,
    dnsRecordType: definition.dnsRecordType,
    startedAt,
    forbiddenValues: [current.site.hostingerUsername, current.site.primaryDomain],
  });
  return {
    accepted: true,
    visibleInHostinger: true,
    referenceId: claim.operation.referenceId,
    idempotencyStatus: "created",
  };
}

async function domainRead<T extends { correlationId?: string }>(
  current: DomainAccessContext,
  capability: HostingerSiteCapability,
  phase: HostingerDiagnosticPhase,
  category: NonNullable<HostingerOperationDiagnostic["resourceCategory"]>,
  read: (client: DomainClient) => Promise<T>,
  dependencies: DomainDependencies,
) {
  const referenceId = dependencies.createReferenceId?.() ?? createDiagnosticReferenceId();
  const startedAt = Date.now();
  const audit = dependencies.audit ?? writeAuditEvent;
  try {
    const result = await read(dependencies.client ?? createHostingerClient());
    await safeAudit(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: `hostinger_${phase}`,
      targetType: category,
      result: "SUCCESS",
      metadata: { capability, referenceId, resourceCategory: category },
    });
    reportHostingerOperationDiagnostic({
      referenceId,
      phase,
      upstreamStatus: 200,
      correlationId: result.correlationId,
      operationType: capability,
      idempotencyStatus: "not_applicable",
      result: "success",
      resourceCategory: category,
      startedAt,
      forbiddenValues: [current.site.hostingerUsername, current.site.primaryDomain],
    });
    return result;
  } catch (error) {
    const controlled = controlledDomainError(error, referenceId, current);
    await safeAudit(audit, {
      actorUserId: current.user.id,
      siteId: current.site.siteId,
      operation: `hostinger_${phase}_failed`,
      targetType: category,
      result: "FAILURE",
      metadata: {
        capability,
        referenceId,
        resourceCategory: category,
        status: controlled.status,
      },
    });
    reportHostingerOperationDiagnostic({
      referenceId,
      phase,
      upstreamStatus: controlled.status,
      correlationId: controlled.correlationId,
      operationType: capability,
      idempotencyStatus: "not_applicable",
      result: "failure",
      resourceCategory: category,
      startedAt,
      forbiddenValues: [current.site.hostingerUsername, current.site.primaryDomain],
    });
    throw controlled;
  }
}

function auditEvent(
  current: DomainAccessContext,
  definition: MutationDefinition,
  suffix: string,
  result: "SUCCESS" | "FAILURE" | "DENIED",
  referenceId: string,
  idempotencyStatus: string,
  error?: AppError,
) {
  return {
    actorUserId: current.user.id,
    siteId: current.site.siteId,
    operation: `hostinger_${definition.operationType}_${suffix}`,
    targetType: definition.category,
    targetIdentifier: definition.targetIdentifier,
    result,
    metadata: {
      capability: definition.capability,
      referenceId,
      phase: definition.phase,
      status: error?.status ?? (result === "SUCCESS" ? 200 : 409),
      idempotencyStatus,
      resourceCategory: definition.category,
      dnsRecordType: definition.dnsRecordType,
      correlationId: error?.correlationId,
    },
  } as const;
}

async function auditClaim(
  current: DomainAccessContext,
  definition: MutationDefinition,
  claim: Exclude<HostingerOperationClaim, { kind: "claimed" }>,
  audit: typeof writeAuditEvent,
) {
  await safeAudit(
    audit,
    auditEvent(
      current,
      definition,
      claim.kind === "duplicate" ? "duplicate" : "blocked",
      claim.kind === "duplicate" && claim.operation.status === "SUCCEEDED" ? "SUCCESS" : "DENIED",
      claim.operation.referenceId,
      claim.kind === "blocked" ? claim.reason : claim.operation.status,
    ),
  );
}

function controlledDomainError(error: unknown, referenceId: string, current: DomainAccessContext) {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.status === 504
        ? "The Hostinger result is ambiguous. The dashboard did not retry the mutation."
        : error.message,
      error.status,
      safeCorrelationId(error.correlationId, current),
      referenceId,
      error.retryAfterSeconds,
    );
  }
  return new AppError(
    "HOSTINGER_ERROR",
    "Hostinger domain data is temporarily unavailable.",
    503,
    undefined,
    referenceId,
  );
}

function safeCorrelationId(value: unknown, current: DomainAccessContext) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    value.includes("://")
  ) return undefined;
  const normalized = value.toLowerCase();
  return [current.site.primaryDomain, current.site.hostingerUsername].some((item) =>
    normalized.includes(item.toLowerCase()),
  )
    ? undefined
    : value;
}

function compareZones(snapshot: DnsRecordGroup[], current: DnsRecordGroup[]) {
  const previous = recordIdentitySet(snapshot);
  const now = recordIdentitySet(current);
  let unchanged = 0;
  for (const value of previous) if (now.has(value)) unchanged += 1;
  return {
    added: [...now].filter((value) => !previous.has(value)).length,
    removed: [...previous].filter((value) => !now.has(value)).length,
    unchanged,
  };
}

function recordIdentitySet(groups: DnsRecordGroup[]) {
  return new Set(
    groups.flatMap((group) =>
      group.records.map((record) =>
        JSON.stringify([group.fqdn, group.type, group.ttl ?? null, record.content, record.isDisabled]),
      ),
    ),
  );
}

function findExactRecord(
  groups: DnsRecordGroup[],
  name: string,
  type: OfficialDnsRecordType,
  content: string,
) {
  return groups
    .find((group) => group.fqdn === name && group.type === type)
    ?.records.find((record) => record.content === content);
}

function isAmbiguousMutationError(error: unknown) {
  return error instanceof AppError && [404, 503, 504].includes(error.status);
}

function currentDomain(value: string) {
  return normalizeDnsOwnerName("@", value).fqdn;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueId(value: string) {
  return hash(value).slice(0, 32);
}

async function safeFinish(
  finish: typeof finishHostingerOperation,
  input: Parameters<typeof finishHostingerOperation>[0],
) {
  try {
    return await finish(input);
  } catch {
    return false;
  }
}

async function safeAudit(
  audit: typeof writeAuditEvent,
  event: Parameters<typeof writeAuditEvent>[0],
) {
  try {
    await audit(event);
  } catch {
    // Audit persistence never causes an external mutation retry.
  }
}
