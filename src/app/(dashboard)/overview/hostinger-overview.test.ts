import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("post-import overview boundary", () => {
  it("contains no Neon, PostgreSQL, Vercel, session or internal infrastructure copy", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(dashboard)/overview/page.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("sites.name");
    expect(source).toContain("sites.primaryDomain");
    expect(source).toContain("sites.status");
    expect(source).toContain("sites.nodeEnabled");
    expect(source).toContain("sites.lastSyncedAt");
    expect(source).not.toMatch(
      /Neon|PostgreSQL|Vercel|persistent DB sessions|authentication|active users|infrastructure status|capabilit(?:y|ies) boundary/i,
    );
    expect(source).not.toContain("HOSTINGER_API_TOKEN");
    expect(source).not.toContain("build.uuid");
  });

  it("uses only site identity, Hostinger builds, restart and domain-confined databases", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(dashboard)/overview/page.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("Configured Hostinger site");
    expect(source).toContain("getDatabaseOverviewForSite");
    expect(source).toContain("listBuildsForSite");
    expect(source).toContain("getNodeRestartCooldownSeconds");
    expect(source).toContain("Hostinger databases");
    expect(source).toContain("Database synchronization");
    expect(source).toContain("Not available");
  });
});
