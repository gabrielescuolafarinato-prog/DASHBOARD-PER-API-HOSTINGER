import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getCurrentDashboardAccess: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentDashboardAccess: dependencies.getCurrentDashboardAccess,
}));
vi.mock("@/lib/audit", () => ({
  writeAuditEvent: dependencies.writeAuditEvent,
}));

import { requireNodeApiAccess } from "./api-access";

beforeEach(() => {
  dependencies.getCurrentDashboardAccess.mockReset();
  dependencies.writeAuditEvent.mockReset();
  dependencies.writeAuditEvent.mockResolvedValue(undefined);
});

describe("build API access boundary", () => {
  it.each(["ADMIN", "MEMBER"] as const)(
    "allows an active %s membership",
    async (membershipRole) => {
      dependencies.getCurrentDashboardAccess.mockResolvedValue(
        authenticatedState(membershipRole),
      );
      await expect(
        requireNodeApiAccess("node.deployments.read"),
      ).resolves.toMatchObject({
        user: { id: "actor-1" },
        site: { siteId: "site-1", membershipRole },
      });
    },
  );

  it("denies an authenticated user without membership without revealing a site", async () => {
    dependencies.getCurrentDashboardAccess.mockResolvedValue({
      status: "missing_membership",
      current: { user: { id: "actor-1" } },
    });
    await expect(
      requireNodeApiAccess("node.deployments.read"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(dependencies.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-1",
        siteId: undefined,
        operation: "hostinger_access_denied",
        result: "DENIED",
      }),
    );
  });

  it("denies an inactive user before membership resolution", async () => {
    dependencies.getCurrentDashboardAccess.mockResolvedValue({
      status: "inactive_user",
    });
    await expect(
      requireNodeApiAccess("node.logs.read"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(dependencies.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: undefined,
        operation: "hostinger_access_denied",
        metadata: {
          permission: "node.logs.read",
          reason: "inactive_user",
        },
      }),
    );
  });

  it("returns a controlled 401 for a missing session", async () => {
    dependencies.getCurrentDashboardAccess.mockResolvedValue({
      status: "missing_session",
    });
    await expect(
      requireNodeApiAccess("node.deployments.read"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});

function authenticatedState(membershipRole: "ADMIN" | "MEMBER") {
  return {
    status: "authenticated",
    current: {
      user: { id: "actor-1" },
      site: {
        siteId: "site-1",
        membershipRole,
        name: "Site",
        primaryDomain: "example.com",
        hostingerUsername: "u1",
      },
    },
  };
}
