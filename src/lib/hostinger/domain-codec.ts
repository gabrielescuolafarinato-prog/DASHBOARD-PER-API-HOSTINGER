import "server-only";

import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { normalizeDomain } from "./domain";
import {
  officialDnsRecordTypes,
  type DnsRecordGroup,
  type OfficialDnsRecordType,
} from "./domain-types";

const dnsTypeSchema = z.enum(officialDnsRecordTypes);
const safeInteger = z.number().int().nonnegative().safe();
const timestampSchema = z.iso.datetime({ offset: true });
const nameRecordSchema = z.object({
  content: z.string().min(1).max(16_384),
  is_disabled: z.boolean().optional(),
});
const zoneGroupSchema = z.object({
  name: z.string().min(1).max(253),
  type: z.string().min(1).max(16),
  ttl: safeInteger.optional(),
  records: z.array(z.unknown()).min(1).max(10_000),
});
const snapshotSchema = z.object({
  id: z.number().int().positive().safe(),
  created_at: timestampSchema,
});
const snapshotDetailSchema = snapshotSchema.extend({
  snapshot: z.unknown(),
});
const subdomainSchema = z.object({
  username: z.string().min(1).max(128),
  domain: z.string().min(1).max(253),
  parent_domain: z.string().min(1).max(253),
  subdomain: z.string().min(1).max(253),
});
const aliasSchema = z.object({
  username: z.string().min(1).max(128),
  domain: z.string().min(1).max(253),
  parent_domain: z.string().min(1).max(253),
  type: z.enum(["domain", "ip"]).optional(),
});

export function decodeDnsZone(payload: unknown, primaryDomain: string) {
  const source = collection(payload);
  const groups: DnsRecordGroup[] = [];
  let discarded = 0;
  const seenGroups = new Set<string>();
  for (const candidate of source) {
    const parsed = zoneGroupSchema.safeParse(candidate);
    if (!parsed.success) {
      discarded += 1;
      continue;
    }
    const type = dnsTypeSchema.safeParse(parsed.data.type);
    if (!type.success) {
      discarded += 1;
      continue;
    }
    let owner: ReturnType<typeof normalizeDnsOwnerName>;
    try {
      owner = normalizeDnsOwnerName(parsed.data.name, primaryDomain);
    } catch {
      discarded += 1;
      continue;
    }
    const groupIdentity = `${owner.fqdn}\0${type.data}`;
    if (seenGroups.has(groupIdentity)) {
      discarded += 1;
      continue;
    }
    const records = [];
    for (const rawRecord of parsed.data.records) {
      const record = nameRecordSchema.safeParse(rawRecord);
      if (!record.success || !isValidDnsContent(type.data, record.data.content)) {
        discarded += 1;
        continue;
      }
      records.push({
        content: record.data.content,
        isDisabled: record.data.is_disabled ?? false,
      });
    }
    if (records.length === 0) {
      discarded += 1;
      continue;
    }
    groups.push({
      name: owner.relative,
      fqdn: owner.fqdn,
      type: type.data,
      ttl: parsed.data.ttl,
      records,
    });
    seenGroups.add(groupIdentity);
  }
  return { groups, discarded };
}

export function decodeDnsSnapshots(payload: unknown) {
  const source = collection(payload);
  const snapshots: { id: string; createdAt: string }[] = [];
  let discarded = 0;
  const seen = new Set<number>();
  for (const candidate of source) {
    const parsed = snapshotSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) {
      discarded += 1;
      continue;
    }
    seen.add(parsed.data.id);
    snapshots.push({
      id: String(parsed.data.id),
      createdAt: parsed.data.created_at,
    });
  }
  return { snapshots, discarded };
}

export function decodeDnsSnapshot(payload: unknown, primaryDomain: string) {
  const parsed = snapshotDetailSchema.safeParse(payload);
  if (!parsed.success) throw malformedResponse();
  const zone = decodeDnsZone(parsed.data.snapshot, primaryDomain);
  return {
    id: String(parsed.data.id),
    createdAt: parsed.data.created_at,
    groups: zone.groups,
    discarded: zone.discarded,
  };
}

export function decodeSubdomains(
  payload: unknown,
  username: string,
  primaryDomain: string,
) {
  const parent = normalizeDomain(primaryDomain);
  const values: { fqdn: string; label: string }[] = [];
  let discarded = 0;
  const seen = new Set<string>();
  for (const candidate of collection(payload)) {
    const parsed = subdomainSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.username !== username) {
      discarded += 1;
      continue;
    }
    try {
      const parsedParent = normalizeDomain(parsed.data.parent_domain);
      const fqdn = normalizeDomain(parsed.data.domain);
      const normalized = normalizeSubdomainInput(
        parsed.data.subdomain,
        parent,
      );
      if (
        parsedParent !== parent ||
        normalized.fqdn !== fqdn ||
        seen.has(fqdn)
      ) {
        discarded += 1;
        continue;
      }
      seen.add(fqdn);
      values.push(normalized);
    } catch {
      discarded += 1;
    }
  }
  return { subdomains: values, discarded };
}

export function decodeAliases(
  payload: unknown,
  username: string,
  primaryDomain: string,
) {
  const parent = normalizeDomain(primaryDomain);
  const aliases: string[] = [];
  let discarded = 0;
  const seen = new Set<string>();
  for (const candidate of collection(payload)) {
    const parsed = aliasSchema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.username !== username ||
      parsed.data.type === "ip"
    ) {
      discarded += 1;
      continue;
    }
    try {
      const parsedParent = normalizeDomain(parsed.data.parent_domain);
      const alias = normalizeAliasInput(parsed.data.domain, parent);
      if (parsedParent !== parent || seen.has(alias)) {
        discarded += 1;
        continue;
      }
      seen.add(alias);
      aliases.push(alias);
    } catch {
      discarded += 1;
    }
  }
  return { aliases, discarded };
}

export function normalizeDnsOwnerName(input: string, primaryDomain: string) {
  const domain = normalizeDomain(primaryDomain);
  if (typeof input !== "string" || /[\u0000-\u001f\u007f]/.test(input)) {
    throw invalidDnsValue("The DNS record name is invalid.");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw invalidDnsValue("The DNS record name is invalid.");
  }
  if (trimmed === "@") {
    return { relative: "@", fqdn: domain };
  }
  const wildcard = trimmed.startsWith("*.");
  const body = wildcard ? trimmed.slice(2) : trimmed;
  if (!body || /[/:?#@\\*]/.test(body)) {
    throw invalidDnsValue("The DNS record name is invalid.");
  }
  const withoutDot = body.endsWith(".") ? body.slice(0, -1) : body;
  const asAbsolute = normalizeDnsOwnerLabels(withoutDot);
  if (!wildcard && asAbsolute === domain) {
    return { relative: "@", fqdn: domain };
  }
  const fqdn = asAbsolute.endsWith(`.${domain}`)
    ? asAbsolute
    : `${asAbsolute}.${domain}`;
  if (fqdn === domain || !fqdn.endsWith(`.${domain}`)) {
    throw invalidDnsValue("The DNS record must belong to the configured domain.");
  }
  const relative = fqdn.slice(0, -(domain.length + 1));
  return {
    relative: wildcard ? `*.${relative}` : relative,
    fqdn: wildcard ? `*.${fqdn}` : fqdn,
  };
}

export function normalizeDnsContent(
  type: OfficialDnsRecordType,
  input: string,
) {
  if (type === "TXT") {
    if (!isValidTxt(input)) throw invalidDnsValue("The TXT value is invalid.");
    return input;
  }
  const value = input.trim();
  if (!isValidDnsContent(type, value)) {
    throw invalidDnsValue(`The ${type} value is invalid.`);
  }
  if (type === "A" || type === "AAAA") return value;
  if (type === "CNAME" || type === "ALIAS" || type === "NS") {
    return normalizeTarget(value);
  }
  if (type === "MX") {
    const [priority, ...target] = value.split(/\s+/);
    return `${priority} ${normalizeTarget(target.join(""))}`;
  }
  if (type === "SRV") {
    const [priority, weight, port, ...target] = value.split(/\s+/);
    return `${priority} ${weight} ${port} ${normalizeTarget(target.join(""))}`;
  }
  if (type === "SOA") {
    const [mname, rname, ...numbers] = value.split(/\s+/);
    return `${normalizeTarget(mname)} ${normalizeTarget(rname)} ${numbers.join(" ")}`;
  }
  return value;
}

export function normalizeSubdomainInput(input: string, primaryDomain: string) {
  const domain = normalizeDomain(primaryDomain);
  if (typeof input !== "string" || input.includes("..") || input.startsWith("*.")) {
    throw invalidDnsValue("The subdomain is invalid.");
  }
  const trimmed = input.trim();
  if (trimmed === "*" || trimmed === domain || trimmed === `${domain}.`) {
    throw invalidDnsValue("Enter a subdomain below the configured domain.");
  }
  let fqdn: string;
  if (trimmed.includes(".")) {
    fqdn = normalizeDomain(trimmed);
  } else {
    fqdn = normalizeDomain(`${trimmed}.${domain}`);
  }
  if (fqdn === domain || !fqdn.endsWith(`.${domain}`)) {
    throw invalidDnsValue("The subdomain must belong to the configured domain.");
  }
  return { fqdn, label: fqdn.slice(0, -(domain.length + 1)) };
}

export function normalizeSubdomainDirectory(value?: string | null) {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value !== value.trim() ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === ".." || part === ".")
  ) {
    throw invalidDnsValue("The subdomain directory must be relative to the site root.");
  }
  return value;
}

export function normalizeAliasInput(input: string, primaryDomain: string) {
  const alias = normalizeDomain(input);
  const primary = normalizeDomain(primaryDomain);
  if (
    alias === primary ||
    isIP(alias) !== 0 ||
    alias === "localhost" ||
    alias.endsWith(".localhost") ||
    alias.endsWith(".local") ||
    alias.endsWith(".internal") ||
    alias.endsWith(".test") ||
    alias.endsWith(".invalid")
  ) {
    throw invalidDnsValue("The domain alias is not allowed.");
  }
  return alias;
}

export function parseSnapshotId(input: string) {
  if (!/^[1-9]\d{0,15}$/.test(input)) {
    throw invalidDnsValue("The DNS snapshot identifier is invalid.");
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value)) {
    throw invalidDnsValue("The DNS snapshot identifier is invalid.");
  }
  return value;
}

export function dnsPriority(type: OfficialDnsRecordType, content: string) {
  if (type !== "MX" && type !== "SRV") return undefined;
  const value = Number(content.trim().split(/\s+/, 1)[0]);
  return Number.isInteger(value) ? value : undefined;
}

function isValidDnsContent(type: OfficialDnsRecordType, input: string) {
  if (type === "TXT") return isValidTxt(input);
  const value = input.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (type === "A") return isIP(value) === 4;
  if (type === "AAAA") return isIP(value) === 6;
  if (type === "CNAME" || type === "ALIAS" || type === "NS") {
    return isTarget(value);
  }
  if (type === "MX") {
    const parts = value.split(/\s+/);
    return parts.length === 2 && uint(parts[0], 65_535) && isTarget(parts[1]);
  }
  if (type === "SRV") {
    const parts = value.split(/\s+/);
    return parts.length === 4 && parts.slice(0, 3).every((part) => uint(part, 65_535)) && isTarget(parts[3]);
  }
  if (type === "SOA") {
    const parts = value.split(/\s+/);
    return parts.length === 7 && isTarget(parts[0]) && isTarget(parts[1]) && parts.slice(2).every((part) => uint(part, 4_294_967_295));
  }
  if (type === "CAA") {
    const match = value.match(/^(\d{1,3})\s+([A-Za-z0-9-]{1,15})\s+(.+)$/);
    return Boolean(match && uint(match[1], 255) && match[3].length <= 4_096);
  }
  return false;
}

function isValidTxt(value: string) {
  return value.length > 0 && value.length <= 16_384 && !/[\u0000\r\n]/.test(value);
}

function uint(value: string, max: number) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max;
}

function isTarget(value: string) {
  try {
    normalizeTarget(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTarget(value: string) {
  const rooted = value.endsWith(".");
  const body = rooted ? value.slice(0, -1) : value;
  const normalized = normalizeDomain(body);
  return rooted ? `${normalized}.` : normalized;
}

function normalizeDnsOwnerLabels(value: string) {
  const labels = value.split(".");
  if (labels.some((label) => label.length === 0)) {
    throw invalidDnsValue("The DNS record name is invalid.");
  }
  const normalized = labels.map((label) => {
    if (label.includes("_")) {
      const ascii = label.toLowerCase();
      if (
        ascii.length > 63 ||
        !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(ascii)
      ) {
        throw invalidDnsValue("The DNS record name is invalid.");
      }
      return ascii;
    }
    const ascii = domainToASCII(label).toLowerCase();
    if (
      !ascii ||
      ascii.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ascii)
    ) {
      throw invalidDnsValue("The DNS record name is invalid.");
    }
    return ascii;
  });
  const result = normalized.join(".");
  if (result.length > 253) {
    throw invalidDnsValue("The DNS record name is invalid.");
  }
  return result;
}

function collection(payload: unknown) {
  const candidate =
    payload && typeof payload === "object" && !Array.isArray(payload) && "data" in payload
      ? (payload as { data: unknown }).data
      : payload;
  if (!Array.isArray(candidate) || candidate.length > 20_000) {
    throw malformedResponse();
  }
  return candidate;
}

function malformedResponse() {
  return new AppError(
    "HOSTINGER_ERROR",
    "Hostinger returned an invalid domain response.",
    502,
  );
}

function invalidDnsValue(message: string) {
  return new AppError("VALIDATION_ERROR", message, 400);
}
