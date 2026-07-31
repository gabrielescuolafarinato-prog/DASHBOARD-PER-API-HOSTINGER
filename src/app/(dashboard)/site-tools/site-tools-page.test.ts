import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cache = read(
  "src/app/(dashboard)/site-tools/cache-manager.tsx",
);
const vulnerabilities = read(
  "src/app/(dashboard)/vulnerabilities/vulnerabilities-manager.tsx",
);
const sidebar = read("src/components/sidebar.tsx");

describe("cache and vulnerability dashboard surfaces", () => {
  it("uses explicit cache actions without claiming current Hostinger state", () => {
    expect(cache).toContain("Clear website cache");
    expect(cache).toContain("Enable");
    expect(cache).toContain("Disable");
    expect(cache).toContain("Last dashboard request");
    expect(cache).toContain("not the current");
    expect(cache).not.toMatch(/type="checkbox".*cache/);
    const requestBuilder = cache.slice(
      cache.indexOf("function actionRequest"),
      cache.indexOf("function operationType"),
    );
    expect(requestBuilder).not.toContain("directory");
  });

  it("explains CDN purge, cache performance and temporary cacheless mode", () => {
    expect(cache).toContain("Hostinger CDN cache");
    expect(cache).toContain("make the website slower");
    expect(cache).toContain(
      "temporary and intended for active development",
    );
  });

  it("selects only patchable items and labels pull requests as review work", () => {
    expect(vulnerabilities).toContain(
      "item.isPatchable && !item.isPatchingInProgress",
    );
    expect(vulnerabilities).toContain("vulnerabilityIds");
    expect(vulnerabilities).toContain("package.json");
    expect(vulnerabilities).toContain(
      'rel="noopener noreferrer"',
    );
    expect(vulnerabilities).toMatch(
      /Review and\s+merge the pull request/,
    );
  });

  it("adds both destinations to the sidebar", () => {
    expect(sidebar).toContain('href: "/site-tools"');
    expect(sidebar).toContain('href: "/vulnerabilities"');
  });
});

function read(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}
