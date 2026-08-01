export const officialDnsRecordTypes = [
  "A",
  "AAAA",
  "CNAME",
  "ALIAS",
  "MX",
  "TXT",
  "NS",
  "SOA",
  "SRV",
  "CAA",
] as const;

export type OfficialDnsRecordType =
  (typeof officialDnsRecordTypes)[number];

export type DnsNameRecord = {
  content: string;
  isDisabled: boolean;
};

export type DnsRecordGroup = {
  name: string;
  fqdn: string;
  type: OfficialDnsRecordType;
  ttl?: number;
  records: DnsNameRecord[];
};

export type DnsRecordView = {
  id: string;
  groupId: string;
  name: string;
  type: OfficialDnsRecordType;
  content: string;
  ttl?: number;
  priority?: number;
  isDisabled: boolean;
  protected: boolean;
  critical: boolean;
  criticalReason?: string;
};

export type DnsZoneView = {
  records: DnsRecordView[];
  fingerprint: string;
  checkedAt: string;
  discarded: number;
  domain: string;
};

export type DnsSnapshotSummary = {
  id: string;
  createdAt: string;
};

export type DnsSnapshotDetail = DnsSnapshotSummary & {
  records: DnsRecordView[];
  comparison?: {
    added: number;
    removed: number;
    unchanged: number;
  };
};

export type SubdomainView = {
  id: string;
  fqdn: string;
  label: string;
};

export type DomainAliasView = {
  id: string;
  hostname: string;
};

export type DomainMutationOutcome = {
  accepted: true;
  visibleInHostinger: boolean;
  referenceId: string;
  idempotencyStatus: "created" | "replayed";
};
