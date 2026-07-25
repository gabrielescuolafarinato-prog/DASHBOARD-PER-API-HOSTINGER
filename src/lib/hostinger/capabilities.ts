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
  ["node.builds.list", "Node.js builds", "SITE_DIRECT", "PLANNED", "List builds for the bound site."],
  ["node.build.logs", "Build logs", "SITE_RESOURCE", "PLANNED", "Read logs for a build UUID bound to the site."],
  ["node.deploy.archive", "Deploy from archive", "SITE_DIRECT", "PLANNED", "Deploy a validated server-side archive."],
  ["node.restart", "Restart Node.js", "SITE_DIRECT", "PLANNED", "Restart only the configured site."],
  ["site.vulnerabilities", "Vulnerabilities", "SITE_DIRECT", "PLANNED", "Read vulnerability data scoped to the site."],
  ["site.cache", "Cache", "SITE_DIRECT", "PLANNED", "Manage cache for the configured site."],
  ["site.databases", "Databases", "SITE_RESOURCE", "PLANNED", "Manage only databases explicitly bound to the site."],
  ["domain.dns", "DNS", "DOMAIN_ASSET", "PLANNED", "Manage the exact configured domain zone."],
  ["site.subdomains", "Subdomains", "SITE_RESOURCE", "PLANNED", "Manage subdomains bound to the site."],
  ["site.aliases", "Aliases", "SITE_RESOURCE", "PLANNED", "Manage aliases bound to the site."],
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
