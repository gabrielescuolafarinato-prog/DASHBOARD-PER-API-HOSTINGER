import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getDb: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: database.getDb }));

import { syncSiteBuilds } from "./build-service";

const siteId = "11111111-1111-4111-8111-111111111111";
const buildUuid = "69f07fe2-197a-4fb3-9dae-606f965ad13d";

beforeEach(() => {
  database.returning.mockReset();
  database.returning.mockResolvedValue([{ uuid: buildUuid }]);
  database.onConflictDoUpdate.mockReset();
  database.onConflictDoUpdate.mockReturnValue({
    returning: database.returning,
  });
  database.values.mockReset();
  database.values.mockReturnValue({
    onConflictDoUpdate: database.onConflictDoUpdate,
  });
  database.getDb.mockReset();
  database.getDb.mockReturnValue({
    insert: vi.fn(() => ({ values: database.values })),
  });
});

describe("build UUID binding synchronization", () => {
  it("upserts the same UUID idempotently against one site", async () => {
    const builds = [
      {
        uuid: buildUuid,
        state: "running" as const,
        origin: "archive" as const,
        createdAt: "2024-05-29T05:49:49.067239Z",
      },
    ];
    await syncSiteBuilds(siteId, builds);
    await syncSiteBuilds(siteId, builds);

    expect(database.values).toHaveBeenCalledTimes(2);
    expect(database.values.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        siteId,
        buildUuid,
        state: "running",
        origin: "archive",
      }),
    ]);
    expect(database.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.anything(),
        setWhere: expect.anything(),
      }),
    );
  });

  it("fails closed when a UUID conflict cannot update the current site", async () => {
    database.returning.mockResolvedValueOnce([]);
    await expect(
      syncSiteBuilds(siteId, [
        { uuid: buildUuid, state: "completed" },
      ]),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Build ownership could not be verified.",
    });
  });
});
