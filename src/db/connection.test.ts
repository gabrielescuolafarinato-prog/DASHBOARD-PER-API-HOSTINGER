import { afterEach, describe, expect, it, vi } from "vitest";

const { neonMock } = vi.hoisted(() => ({ neonMock: vi.fn() }));

vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  neonMock.mockClear();
  vi.resetModules();
});

describe("Neon lazy initialization", () => {
  it("does not initialize Neon while importing the database module", async () => {
    delete process.env.DATABASE_URL;
    await import("./connection");
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("validates configuration before initializing Neon", async () => {
    delete process.env.DATABASE_URL;
    const { getDb } = await import("./connection");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
    expect(neonMock).not.toHaveBeenCalled();
  });
});
