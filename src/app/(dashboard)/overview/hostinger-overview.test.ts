import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("post-import overview boundary", () => {
  it("shows verified site identity and implemented build observability", () => {
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
    expect(source).toContain("Configured site connection verified");
    expect(source).toContain(
      "Build observability and scoped server restart available",
    );
    expect(source).not.toContain("HOSTINGER_API_TOKEN");
    expect(source).not.toContain("build.uuid");
  });
});
