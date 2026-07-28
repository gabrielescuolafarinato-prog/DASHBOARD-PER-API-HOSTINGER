import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  assertTrustedMutationRequest: vi.fn(),
  parseNodeRestartRequest: vi.fn(),
  requireHostingerApiAccess: vi.fn(),
  restartNodeServerForSite: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/security/request-origin", () => ({
  assertTrustedMutationRequest: mocks.assertTrustedMutationRequest,
}));
vi.mock("@/lib/hostinger/restart-input", () => ({
  parseNodeRestartRequest: mocks.parseNodeRestartRequest,
}));
vi.mock("@/lib/hostinger/api-access", () => ({
  requireHostingerApiAccess: mocks.requireHostingerApiAccess,
}));
vi.mock("@/lib/hostinger/restart-service", () => ({
  restartNodeServerForSite: mocks.restartNodeServerForSite,
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

import { POST } from "./route";

const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const current = {
  user: { id: "22222222-2222-4222-8222-222222222222" },
  site: {
    siteId: "11111111-1111-4111-8111-111111111111",
    primaryDomain: "private.example",
    hostingerUsername: "private-user",
    membershipRole: "MEMBER",
  },
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.parseNodeRestartRequest.mockResolvedValue({ idempotencyKey });
  mocks.requireHostingerApiAccess.mockResolvedValue(current);
  mocks.restartNodeServerForSite.mockResolvedValue({
    restarted: true,
    referenceId: "abcdef123456",
    idempotencyStatus: "created",
    cooldownEndsAt: "2026-07-29T10:00:30.000Z",
  });
});

describe("POST /api/node/restart", () => {
  it("uses only authoritative access state and returns a minimal result", async () => {
    const request = restartRequest();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.assertTrustedMutationRequest).toHaveBeenCalledWith(request);
    expect(mocks.requireHostingerApiAccess).toHaveBeenCalledWith(
      "node.restart",
    );
    expect(mocks.restartNodeServerForSite).toHaveBeenCalledWith(
      current,
      idempotencyKey,
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        restarted: true,
        referenceId: "abcdef123456",
        idempotencyStatus: "created",
        cooldownEndsAt: "2026-07-29T10:00:30.000Z",
      },
    });
    expect(mocks.revalidatePath.mock.calls).toEqual([
      ["/overview"],
      ["/builds"],
    ]);
  });

  it("rejects an invalid origin before session or Hostinger access", async () => {
    mocks.assertTrustedMutationRequest.mockImplementation(() => {
      throw new AppError(
        "FORBIDDEN",
        "The request origin is not allowed.",
        403,
      );
    });

    const response = await POST(restartRequest());

    expect(response.status).toBe(403);
    expect(mocks.parseNodeRestartRequest).not.toHaveBeenCalled();
    expect(mocks.requireHostingerApiAccess).not.toHaveBeenCalled();
    expect(mocks.restartNodeServerForSite).not.toHaveBeenCalled();
  });

  it.each([
    ["no membership", new AppError("NOT_FOUND", "Site not found.", 404)],
    ["inactive or banned user", new AppError("FORBIDDEN", "Access denied.", 403)],
  ])("denies %s without calling the restart service", async (_label, error) => {
    mocks.requireHostingerApiAccess.mockRejectedValue(error);

    const response = await POST(restartRequest());

    expect(response.status).toBe(error.status);
    expect(mocks.restartNodeServerForSite).not.toHaveBeenCalled();
  });
});

function restartRequest() {
  return new NextRequest("https://console.test/api/node/restart", {
    method: "POST",
    headers: {
      Origin: "https://console.test",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: "{}",
  });
}
