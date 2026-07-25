import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireOwnerOnboarding: vi.fn(),
  requireSession: vi.fn(),
  verifyConfiguredHostingerSite: vi.fn(),
  precheckConfiguredHostingerSite: vi.fn(),
  importVerifiedConfiguredSite: vi.fn(),
  reportUnexpectedImportFailure: vi.fn(),
  logRecoveredImportIssue: vi.fn(),
  writeAuditEvent: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  configuration: {
    status: "ready",
    configured: true,
    domain: "example.com",
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("@/lib/auth/session", () => ({
  requireOwner: vi.fn(),
  requireSession: mocks.requireSession,
  requireOwnerOnboarding: mocks.requireOwnerOnboarding,
}));
vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(),
}));
vi.mock("@/lib/team/service", () => ({
  createCollaborator: vi.fn(),
  setUserActive: vi.fn(),
}));
vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));
vi.mock("@/lib/env", () => ({
  getHostingerConfigurationState: () => mocks.configuration,
}));
vi.mock("@/lib/hostinger/site-sync", () => ({
  verifyConfiguredHostingerSite: mocks.verifyConfiguredHostingerSite,
  precheckConfiguredHostingerSite: mocks.precheckConfiguredHostingerSite,
  importVerifiedConfiguredSite: mocks.importVerifiedConfiguredSite,
  reportUnexpectedImportFailure: mocks.reportUnexpectedImportFailure,
  logRecoveredImportIssue: mocks.logRecoveredImportIssue,
}));

import {
  importHostingerSiteAction,
  verifyHostingerSiteAction,
} from "./actions";

const owner = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Owner",
    role: "OWNER",
    isActive: true,
  },
};
const verified = {
  domain: "example.com",
  username: "server-username",
  orderId: "order-1",
  siteStatus: "VERIFIED",
  nodeEnabled: true,
  correlationId: "corr-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configuration.status = "ready";
  mocks.configuration.configured = true;
  mocks.configuration.domain = "example.com";
  mocks.requireOwnerOnboarding.mockResolvedValue(owner);
  mocks.requireSession.mockResolvedValue(owner);
  mocks.verifyConfiguredHostingerSite.mockResolvedValue(verified);
  mocks.precheckConfiguredHostingerSite.mockResolvedValue({ type: "ready" });
  mocks.importVerifiedConfiguredSite.mockResolvedValue({
    type: "imported",
    siteId: "22222222-2222-4222-8222-222222222222",
  });
  mocks.reportUnexpectedImportFailure.mockResolvedValue({
    type: "persistence_failed",
    phase: "database_import",
    referenceId: "ABC123",
  });
  mocks.writeAuditEvent.mockResolvedValue(undefined);
  mocks.redirect.mockImplementation((destination: string) => {
    throw Object.assign(new Error(`REDIRECT:${destination}`), {
      digest: `NEXT_REDIRECT;replace;${destination};307;`,
    });
  });
});

describe("Hostinger onboarding server actions", () => {
  it("allows only the active OWNER onboarding state to verify", async () => {
    const result = await verifyHostingerSiteAction(
      { ok: false, status: "idle" },
      new FormData(),
    );
    expect(result).toEqual({
      ok: true,
      status: "verified",
      message:
        "Sito Hostinger verificato. Conferma prima dell’importazione.",
      site: {
        domain: "example.com",
        siteStatus: "VERIFIED",
        nodeEnabled: true,
        orderId: "order-1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("server-username");
    expect(JSON.stringify(result)).not.toContain("mock-token");
  });

  it("rejects a COLLABORATOR and an anonymous request", async () => {
    mocks.requireOwnerOnboarding.mockResolvedValueOnce({
      user: { ...owner.user, role: "COLLABORATOR" },
    });
    await expect(
      verifyHostingerSiteAction(
        { ok: false, status: "idle" },
        new FormData(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();

    mocks.requireOwnerOnboarding.mockRejectedValueOnce(
      new AppError("UNAUTHENTICATED", "Authentication required.", 401),
    );
    await expect(
      verifyHostingerSiteAction(
        { ok: false, status: "idle" },
        new FormData(),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects a wrong confirmation before repeating Hostinger verification", async () => {
    const formData = new FormData();
    formData.set("confirmationDomain", "other-customer.com");
    const result = await importHostingerSiteAction(
      { ok: false, status: "idle" },
      formData,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "CONFIRMATION_MISMATCH",
    });
    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_conflict",
        result: "DENIED",
      }),
    );
  });

  it("lets the special Next.js redirect escape after successful SQL import", async () => {
    const formData = new FormData();
    formData.set("confirmationDomain", "EXAMPLE.COM.");
    formData.set("domain", "other-customer.com");
    formData.set("username", "attacker-user");
    formData.set("path", "/api/hosting/v1/orders");
    formData.set("method", "DELETE");
    formData.set("token", "fake-browser-token");

    await expect(
      importHostingerSiteAction(
        { ok: false, status: "idle" },
        formData,
      ),
    ).rejects.toThrow("REDIRECT:/overview");

    expect(mocks.verifyConfiguredHostingerSite).toHaveBeenCalledWith(
      owner.user.id,
    );
    expect(mocks.importVerifiedConfiguredSite).toHaveBeenCalledWith(
      owner.user.id,
      verified,
    );
    expect(
      JSON.stringify(mocks.verifyConfiguredHostingerSite.mock.calls),
    ).not.toContain("other-customer.com");
    expect(
      JSON.stringify(mocks.verifyConfiguredHostingerSite.mock.calls),
    ).not.toContain("attacker-user");
    expect(
      JSON.stringify(mocks.verifyConfiguredHostingerSite.mock.calls),
    ).not.toContain("fake-browser-token");
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith("/overview");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/overview");
    expect(
      mocks.revalidatePath.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mocks.redirect.mock.invocationCallOrder[0]);
  });

  it("redirects an already completed import without calling Hostinger again", async () => {
    mocks.precheckConfiguredHostingerSite.mockResolvedValueOnce({
      type: "already_imported",
      siteId: "22222222-2222-4222-8222-222222222222",
    });
    const formData = new FormData();
    formData.set("confirmationDomain", "example.com");

    await expect(
      importHostingerSiteAction(
        { ok: false, status: "idle" },
        formData,
      ),
    ).rejects.toThrow("REDIRECT:/overview");

    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();
    expect(mocks.importVerifiedConfiguredSite).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/overview");
  });

  it("keeps a single-site conflict on onboarding as a typed state", async () => {
    mocks.precheckConfiguredHostingerSite.mockResolvedValueOnce({
      type: "single_site_conflict",
      reason: "different_site",
    });

    await expect(
      importHostingerSiteAction(
        { ok: false, status: "idle" },
        new FormData(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      code: "SINGLE_SITE_CONFLICT",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();
  });

  it("maps an expected Hostinger error without a generic exception", async () => {
    mocks.verifyConfiguredHostingerSite.mockRejectedValueOnce(
      new AppError("RATE_LIMITED", "sensitive upstream detail", 429, "corr-1"),
    );
    const formData = new FormData();
    formData.set("confirmationDomain", "example.com");

    const result = await importHostingerSiteAction(
      { ok: false, status: "idle" },
      formData,
    );
    expect(result).toMatchObject({
      ok: false,
      status: "error",
      code: "HOSTINGER_RATE_LIMITED",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive upstream detail");
    expect(mocks.importVerifiedConfiguredSite).not.toHaveBeenCalled();
  });

  it("returns only a reference ID for a database failure", async () => {
    mocks.importVerifiedConfiguredSite.mockResolvedValueOnce({
      type: "persistence_failed",
      phase: "database_import",
      referenceId: "DB7A91",
    });
    const formData = new FormData();
    formData.set("confirmationDomain", "example.com");

    const result = await importHostingerSiteAction(
      { ok: false, status: "idle" },
      formData,
    );
    expect(result).toEqual({
      ok: false,
      status: "error",
      code: "DATABASE_IMPORT_FAILED",
      referenceId: "DB7A91",
      message: "Importazione non completata. Riferimento: DB7A91",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /postgres|constraint|database_url|bearer/i,
    );
  });

  it("reports a pre-save database failure without calling Hostinger", async () => {
    mocks.precheckConfiguredHostingerSite.mockResolvedValueOnce({
      type: "persistence_failed",
      phase: "precheck",
      referenceId: "PRE123",
    });

    const result = await importHostingerSiteAction(
      { ok: false, status: "idle" },
      new FormData(),
    );
    expect(result).toEqual({
      ok: false,
      status: "error",
      code: "DATABASE_IMPORT_FAILED",
      referenceId: "PRE123",
      message: "Importazione non completata. Riferimento: PRE123",
    });
    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();
    expect(mocks.importVerifiedConfiguredSite).not.toHaveBeenCalled();
  });

  it("distinguishes result decoding from a database write failure", async () => {
    mocks.importVerifiedConfiguredSite.mockResolvedValueOnce({
      type: "persistence_failed",
      phase: "result_decode",
      referenceId: "DEC123",
    });
    const formData = new FormData();
    formData.set("confirmationDomain", "example.com");

    await expect(
      importHostingerSiteAction(
        { ok: false, status: "idle" },
        formData,
      ),
    ).resolves.toMatchObject({
      code: "RESULT_DECODE_FAILED",
      referenceId: "DEC123",
    });
  });

  it("does not intercept a Next.js redirect raised by the session guard", async () => {
    const nextRedirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/overview;307;",
    });
    mocks.requireSession.mockRejectedValueOnce(nextRedirect);

    await expect(
      importHostingerSiteAction(
        { ok: false, status: "idle" },
        new FormData(),
      ),
    ).rejects.toBe(nextRedirect);
    expect(mocks.reportUnexpectedImportFailure).not.toHaveBeenCalled();
  });

  it("contains no generic Hostinger proxy or browser-controlled request API", () => {
    const actions = readFileSync(
      path.resolve(process.cwd(), "src/app/actions.ts"),
      "utf8",
    );
    const client = readFileSync(
      path.resolve(process.cwd(), "src/lib/hostinger/client.ts"),
      "utf8",
    );
    expect(actions.startsWith('"use server"')).toBe(true);
    expect(actions).not.toContain("formData.get(\"username\")");
    expect(actions).not.toContain("formData.get(\"token\")");
    expect(actions).not.toContain("formData.get(\"method\")");
    expect(client).not.toContain("public request(");
    expect(
      readFileSync(
        path.resolve(process.cwd(), "src/app/actions.ts"),
        "utf8",
      ),
    ).not.toContain("/api/hostinger/proxy");
  });
});
