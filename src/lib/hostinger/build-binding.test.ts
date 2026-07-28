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

  it.each([
    {
      name: "direct undefined table",
      error: {
        name: "NeonDbError",
        code: "42P01",
        schema: "public",
        table: "site_builds",
      },
      sqlstate: "42P01",
      errorType: "NeonDbError",
    },
    {
      name: "undefined table in cause",
      error: Object.assign(new Error("wrapped"), {
        name: "DrizzleQueryError",
        cause: {
          name: "DatabaseError",
          code: "42P01",
          table: "site_builds",
        },
      }),
      sqlstate: "42P01",
      errorType: "DatabaseError",
    },
    {
      name: "direct undefined enum",
      error: {
        name: "PostgresError",
        code: "42704",
        schema: "public",
        dataType: "build_state",
      },
      sqlstate: "42704",
      errorType: "PostgresError",
    },
    {
      name: "undefined enum in a limited cause chain",
      error: {
        name: "DrizzleQueryError",
        cause: {
          name: "Error",
          cause: {
            name: "NeonDbError",
            code: "42704",
            dataType: "build_state",
          },
        },
      },
      sqlstate: "42704",
      errorType: "NeonDbError",
    },
  ])(
    "maps $name to a controlled migration error",
    async ({ error, sqlstate, errorType }) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      database.returning.mockRejectedValueOnce(error);

      let caught: unknown;
      try {
        await syncSiteBuilds(siteId, [
          { uuid: buildUuid, state: "completed" },
        ]);
      } catch (failure) {
        caught = failure;
      }

      expect(caught).toMatchObject({
        code: "DATABASE_MIGRATION_REQUIRED",
        status: 503,
        message: "Database update required.",
        referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
      });
      expect(consoleError).toHaveBeenCalledWith(
        "database_schema_diagnostic",
        {
          referenceId: expect.stringMatching(/^[a-f0-9]{12}$/),
          phase: "site_build_sync",
          sqlstate,
          errorType,
          expectedMigration: "0002",
          result: "failure",
        },
      );
      expect((caught as { referenceId?: string }).referenceId).toBe(
        (consoleError.mock.calls[0][1] as { referenceId: string })
          .referenceId,
      );
      consoleError.mockRestore();
    },
  );

  it("logs no SQL, values, connection details or raw cause data", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    database.returning.mockRejectedValueOnce({
      name: "NeonDbError",
      code: "42P01",
      table: "site_builds",
      message:
        "relation missing for private.example and private-user",
      query: "INSERT INTO site_builds VALUES ($1)",
      params: [buildUuid, "private-token"],
      connectionString:
        "postgresql://private-user:private-password@private.invalid/db",
      stack: "private-stack",
      cause: { raw: "private-cause" },
    });

    await expect(
      syncSiteBuilds(siteId, [
        { uuid: buildUuid, state: "completed" },
      ]),
    ).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_REQUIRED",
      status: 503,
    });

    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      new RegExp(
        [
          "INSERT INTO",
          "private\\.example",
          "private-user",
          "private-password",
          "private-token",
          "private\\.invalid",
          buildUuid,
          "private-stack",
          "private-cause",
          "params",
          "connectionString",
        ].join("|"),
        "i",
      ),
    );
    consoleError.mockRestore();
  });

  it.each([
    Object.assign(new Error("generic database failure"), {
      code: "XX000",
    }),
    Object.assign(new Error("unique violation"), { code: "23505" }),
    {
      name: "NeonDbError",
      code: "42P01",
      table: "unrelated_table",
    },
    {
      name: "NeonDbError",
      code: "42704",
      dataType: "unrelated_type",
    },
  ])("does not misclassify unrelated database error %#", async (error) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    database.returning.mockRejectedValueOnce(error);

    await expect(
      syncSiteBuilds(siteId, [
        { uuid: buildUuid, state: "completed" },
      ]),
    ).rejects.toBe(error);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
