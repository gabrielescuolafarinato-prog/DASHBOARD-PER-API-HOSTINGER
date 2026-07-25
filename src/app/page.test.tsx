import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeCurrentSurface = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ authorizeCurrentSurface }));

import HomePage from "./page";

describe("root page routing", () => {
  beforeEach(() => {
    authorizeCurrentSurface.mockReset();
  });

  it.each([
    "/login",
    "/onboarding",
    "/overview",
    "/change-password",
    "/setup-required",
  ])("uses the centralized root decision for %s", async (destination) => {
    authorizeCurrentSurface.mockRejectedValue(
      new Error(`REDIRECT:${destination}`),
    );

    await expect(HomePage()).rejects.toThrow(`REDIRECT:${destination}`);
    expect(authorizeCurrentSurface).toHaveBeenCalledOnce();
    expect(authorizeCurrentSurface).toHaveBeenCalledWith("root");
  });
});
