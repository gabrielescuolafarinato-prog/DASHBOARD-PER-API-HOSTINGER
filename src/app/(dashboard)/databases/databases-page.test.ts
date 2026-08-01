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

  it("never creates an about:blank tab before phpMyAdmin succeeds", () => {
    expect(manager).not.toContain("window.open(");
    expect(manager).not.toContain("about:blank");
    expect(manager).not.toContain("target.location.replace");
    expect(manager).toContain("requestPhpMyAdminLink");
  });

  it("shows a direct manual action that remains usable with popup blocking", () => {
    expect(manager).toContain("Open phpMyAdmin");
    expect(manager).toContain('target="_blank"');
    expect(manager).toContain('rel="noopener noreferrer"');
    expect(manager).toContain('referrerPolicy="no-referrer"');
    expect(manager).toContain("href={phpMyAdminLink.href}");
    expect(manager).not.toContain("validatePhpMyAdminLink");
    expect(manager).not.toContain("validateAuthenticatedPhpMyAdminLink");
    expect(manager).not.toContain(
      "HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES",
    );
  });

  it("keeps the temporary link only in short-lived React state", () => {
    expect(manager).toContain("setPhpMyAdminLink");
    expect(manager).toContain("60_000");
    expect(manager).toContain("onClick={onPhpMyAdminOpened}");
    expect(manager).toContain("setTimeout(() =>");
    expect(manager).toContain(
      "current?.databaseId === databaseId ? undefined : current",
    );
    expect(manager).not.toMatch(/localStorage|sessionStorage/);
  });

  it("blocks duplicate requests only for the selected database", () => {
    expect(manager).toContain("phpMyAdminRequestLocks");
    expect(manager).toContain("claimDatabaseRequest(");
    expect(manager).toContain("phpMyAdminPendingIds.has(");
    expect(manager).toContain("releaseDatabaseRequest(");
  });

  it("shows a controlled failure and reference without creating a window", () => {
    expect(manager).toContain("failure?.referenceId");
    expect(manager).toContain(
      "Hostinger returned an invalid phpMyAdmin link response.",
    );
    expect(manager).toContain(
      "isDiagnosticCode(failure?.diagnosticCode)",
    );
    expect(manager).toContain("Diagnostic: {notice.diagnosticCode}");
    expect(manager).not.toContain("target?.close()");
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
