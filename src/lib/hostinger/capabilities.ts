export const capabilityCategories = [
  "SITE_DIRECT",
  "SITE_RESOURCE",
  "DOMAIN_ASSET",
  "OWNER_ONLY",
  "TEMPLATE_ONLY",
  "BACKEND_INTERNAL",
  "DENY_GLOBAL",
  "NOT_AVAILABLE",
] as const;

export type CapabilityCategory = (typeof capabilityCategories)[number];
export type CapabilityState = "IMPLEMENTED" | "PLANNED" | "DENIED" | "NOT_AVAILABLE";

export type HostingerCapability = {
  key: string;
  label: string;
  category: CapabilityCategory;
  state: CapabilityState;
  description: string;
};

const entries = [
  ["node.builds.list", "Node.js builds", "SITE_DIRECT", "IMPLEMENTED", "List validated builds for the bound site."],
  ["node.build.logs", "Build logs", "SITE_RESOURCE", "IMPLEMENTED", "Read sanitized logs only for a build UUID bound to the site."],
  ["node.deploy.archive", "Deploy from archive", "SITE_DIRECT", "PLANNED", "Deploy a validated server-side archive."],
  ["node.restart", "Restart Node.js", "SITE_DIRECT", "IMPLEMENTED", "Restart only the configured site's server process with durable idempotency and cooldown protection."],
  ["site.vulnerabilities.list", "Node.js vulnerabilities", "SITE_DIRECT", "IMPLEMENTED", "List validated vulnerability data for the configured site."],
  ["site.vulnerabilities.patch", "Patch Node.js vulnerabilities", "SITE_DIRECT", "IMPLEMENTED", "Request a pull request for selected live and patchable vulnerabilities."],
  ["site.cache.clear", "Clear website cache", "SITE_DIRECT", "IMPLEMENTED", "Clear all website cache for the configured site."],
  ["site.cache.toggle", "Website cache toggle", "SITE_DIRECT", "IMPLEMENTED", "Explicitly enable or disable cache for the configured site."],
  ["site.cacheless.toggle", "Cacheless mode", "SITE_DIRECT", "IMPLEMENTED", "Explicitly enable or disable development cacheless mode."],
  ["database.list", "Hostinger databases", "SITE_RESOURCE", "IMPLEMENTED", "List only databases live-verified for the configured domain."],
  ["database.create", "Create database", "SITE_RESOURCE", "IMPLEMENTED", "Create a database assigned server-side to the configured domain."],
  ["database.password.change", "Database password change", "SITE_RESOURCE", "IMPLEMENTED", "Change a bound database password without persisting or auditing it."],
  ["database.repair", "Database repair", "SITE_RESOURCE", "IMPLEMENTED", "Queue repair only for a live-verified database binding."],
  ["database.delete", "Database deletion", "SITE_RESOURCE", "IMPLEMENTED", "Delete a live-verified database after typed destructive confirmation."],
  ["database.phpmyadmin.link", "phpMyAdmin link", "SITE_RESOURCE", "IMPLEMENTED", "Generate a validated temporary phpMyAdmin link only on request."],
  ["database.remote.connections", "Database remote connections", "SITE_RESOURCE", "IMPLEMENTED", "Manage specific IP rules only after live database ownership verification."],
  ["dns.records.list", "DNS records", "DOMAIN_ASSET", "IMPLEMENTED", "List the validated zone for the exact configured primary domain."],
  ["dns.records.create", "Create DNS record", "DOMAIN_ASSET", "IMPLEMENTED", "Validate and add one record to the exact configured zone with overwrite disabled."],
  ["dns.records.update", "Update DNS TTL", "DOMAIN_ASSET", "IMPLEMENTED", "Validate a live, fingerprint-matched TTL update with overwrite disabled."],
  ["dns.records.delete", "Delete DNS record group", "DOMAIN_ASSET", "IMPLEMENTED", "Delete a live-verified unprotected name/type group after strong confirmation."],
  ["dns.snapshots.list", "DNS snapshots", "DOMAIN_ASSET", "IMPLEMENTED", "List sanitized read-only snapshots for the exact configured domain."],
  ["dns.snapshots.view", "View DNS snapshot", "DOMAIN_ASSET", "IMPLEMENTED", "View validated snapshot records and a synthetic current-zone comparison."],
  ["dns.snapshots.restore", "Restore DNS snapshot", "DOMAIN_ASSET", "PLANNED", "Restore is intentionally unavailable in this phase."],
  ["dns.zone.reset", "Reset DNS zone", "DOMAIN_ASSET", "PLANNED", "Full-zone reset is intentionally unavailable in this phase."],
  ["subdomains.list", "Subdomains", "SITE_RESOURCE", "IMPLEMENTED", "List only subdomains live-bound to the configured website."],
  ["subdomains.create", "Create subdomain", "SITE_RESOURCE", "IMPLEMENTED", "Create a validated subordinate hostname under the configured website."],
  ["subdomains.delete", "Delete subdomain", "SITE_RESOURCE", "IMPLEMENTED", "Delete only a live-listed subdomain after exact typed confirmation."],
  ["aliases.list", "Domain aliases", "SITE_RESOURCE", "IMPLEMENTED", "List only domain-type parked domains for the configured website."],
  ["aliases.create", "Create domain alias", "SITE_RESOURCE", "IMPLEMENTED", "Create a validated hostname alias for the configured website."],
  ["aliases.delete", "Delete domain alias", "SITE_RESOURCE", "IMPLEMENTED", "Delete only a live-listed alias after exact typed confirmation."],
  ["site.cron", "Cron jobs (limited)", "SITE_RESOURCE", "PLANNED", "Manage only cron jobs created and bound by this app."],
  ["domain.registrar", "Registrar domain", "DOMAIN_ASSET", "PLANNED", "Domain operations for the exact configured domain."],
  ["hostinger.site.sync", "Site verification", "OWNER_ONLY", "IMPLEMENTED", "Verify and persist the exact configured site."],
  ["hostinger.environment", "Hostinger environment variables", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed by the public API."],
  ["hostinger.github.connect", "GitHub repository connection", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed by the public API."],
  ["hostinger.github.branch", "GitHub branch change", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed by the public API."],
  ["hostinger.github.redeploy", "Manual GitHub redeploy", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed by the public API."],
  ["node.runtime.logs", "Complete runtime logs", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed by the public API."],
  ["site.resource.stats", "CPU / RAM statistics", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed for this product via the public API."],
  ["site.file.manager", "File manager", "DENY_GLOBAL", "DENIED", "Not safely confinable to the configured site."],
  ["site.ftp", "FTP / SFTP", "DENY_GLOBAL", "DENIED", "Credentials and broad filesystem access are out of scope."],
  ["site.ssl", "SSL", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed for Business sites via the public API."],
  ["site.backup.restore", "Business backup / restore", "NOT_AVAILABLE", "NOT_AVAILABLE", "Not exposed for Business sites via the public API."],
] as const satisfies readonly (readonly [
  string,
  string,
  CapabilityCategory,
  CapabilityState,
  string,
])[];

export const capabilityRegistry = new Map<string, HostingerCapability>(
  entries.map(([key, label, category, state, description]) => [
    key,
    { key, label, category, state, description },
  ]),
);

export function getCapability(key: string): HostingerCapability {
  return (
    capabilityRegistry.get(key) ?? {
      key,
      label: key,
      category: "DENY_GLOBAL",
      state: "DENIED",
      description: "Unregistered capabilities are denied by default.",
    }
  );
}

export function listCapabilities() {
  return [...capabilityRegistry.values()];
}
