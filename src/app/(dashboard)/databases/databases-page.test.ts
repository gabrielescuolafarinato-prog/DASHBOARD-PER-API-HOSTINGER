import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manager = read(
  "src/app/(dashboard)/databases/databases-manager.tsx",
);
const sidebar = read("src/components/sidebar.tsx");

describe("database dashboard surface", () => {
  it("provides refresh, pagination, loading, empty and controlled reference states", () => {
    expect(manager).toContain("Refresh");
    expect(manager).toContain("Previous page");
    expect(manager).toContain("Next page");
    expect(manager).toContain("Loading databases");
    expect(manager).toContain("No databases assigned to this site");
    expect(manager).toContain("Reference:");
    expect(manager).toContain(
      "body.error.referenceId",
    );
  });

  it("requires explicit dialogs and exact typed deletion", () => {
    expect(manager).toContain('aria-modal="true"');
    expect(manager).toContain("Confirm password change");
    expect(manager).toContain("Confirm and queue repair");
    expect(manager).toContain("Permanently delete");
    expect(manager).toContain("deleteConfirmation");
    expect(manager).toContain("confirmation: values.deleteConfirmation");
  });

  it("does not send domain, account username or full create names from the browser", () => {
    const createRequest = manager.slice(
      manager.indexOf('if (modal.type === "create")'),
      manager.indexOf('if (modal.type === "password")'),
    );
    expect(createRequest).toContain("nameSuffix");
    expect(createRequest).toContain("userSuffix");
    expect(createRequest).not.toMatch(
      /website_domain|websiteDomain|hostingerUsername|primaryDomain|name:/,
    );
  });

  it("opens phpMyAdmin in a protected new tab without storing the link in state", () => {
    expect(manager).toContain(
      'window.open("", "_blank", "noopener,noreferrer")',
    );
    expect(manager).toContain("target.opener = null");
    expect(manager).toContain("target.location.replace");
    expect(manager).not.toMatch(/setPhp|useState<.*link/i);
  });

  it("adds the Databases destination to the common sidebar", () => {
    expect(sidebar).toContain(
      '{ href: "/databases", label: "Databases", icon: Database }',
    );
  });
});

function read(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}
