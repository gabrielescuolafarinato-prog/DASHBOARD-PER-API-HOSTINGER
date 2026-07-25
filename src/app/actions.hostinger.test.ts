import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireOwnerOnboarding: vi.fn(),
  verifyConfiguredHostingerSite: vi.fn(),
  importVerifiedConfiguredSite: vi.fn(),
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
  requireSession: vi.fn(),
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
  importVerifiedConfiguredSite: mocks.importVerifiedConfiguredSite,
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
  mocks.verifyConfiguredHostingerSite.mockResolvedValue(verified);
  mocks.importVerifiedConfiguredSite.mockResolvedValue({
    outcome: "imported",
    siteId: "22222222-2222-4222-8222-222222222222",
  });
  mocks.writeAuditEvent.mockResolvedValue(undefined);
  mocks.redirect.mockImplementation((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
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
    ).resolves.toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects a wrong confirmation before repeating Hostinger verification", async () => {
    const formData = new FormData();
    formData.set("confirmationDomain", "other-customer.com");
    const result = await importHostingerSiteAction({ ok: false }, formData);
    expect(result).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.verifyConfiguredHostingerSite).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hostinger_site_import_conflict",
        result: "DENIED",
      }),
    );
  });

  it("ignores hostile target fields and redirects once after atomic import", async () => {
    const formData = new FormData();
    formData.set("confirmationDomain", "EXAMPLE.COM.");
    formData.set("domain", "other-customer.com");
    formData.set("username", "attacker-user");
    formData.set("path", "/api/hosting/v1/orders");
    formData.set("method", "DELETE");
    formData.set("token", "fake-browser-token");

    await expect(
      importHostingerSiteAction({ ok: false }, formData),
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
