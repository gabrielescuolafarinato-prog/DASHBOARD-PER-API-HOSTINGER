import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OWNER bootstrap boundary", () => {
  const bootstrap = readFileSync(
    path.resolve(process.cwd(), "scripts/bootstrap-owner.ts"),
    "utf8",
  );

  it("does not require Hostinger configuration", () => {
    expect(bootstrap).not.toContain("getHostingerEnv");
    expect(bootstrap).not.toContain("HOSTINGER_API_TOKEN");
    expect(bootstrap).not.toContain("HOSTINGER_ACCOUNT_USERNAME");
    expect(bootstrap).not.toContain("HOSTINGER_SITE_DOMAIN");
  });

  it("does not create a site or a placeholder membership", () => {
    expect(bootstrap).not.toContain("siteMemberships");
    expect(bootstrap).not.toContain("sites");
    expect(bootstrap).not.toContain("example.com");
    expect(bootstrap).not.toContain("UNCONFIGURED");
  });

  it("reports account creation separately from site onboarding", () => {
    expect(bootstrap).toContain("OWNER created");
    expect(bootstrap).toContain("Site onboarding is still required");
    expect(bootstrap).toContain("Password was not logged");
  });
});
