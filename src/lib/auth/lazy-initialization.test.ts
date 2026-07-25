import { afterEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.AUTH_SECRET;
const originalAppUrl = process.env.APP_URL;

afterEach(() => {
  restore("DATABASE_URL", originalDatabaseUrl);
  restore("AUTH_SECRET", originalAuthSecret);
  restore("APP_URL", originalAppUrl);
  vi.resetModules();
});

describe("lazy server initialization", () => {
  it("imports environment and Better Auth modules without configuration", async () => {
    clearRuntimeConfiguration();
    const environment = await import("@/lib/env");
    const auth = await import("@/lib/auth");

    expect(environment.getRuntimeEnv).toBeTypeOf("function");
    expect(auth.getAuth).toBeTypeOf("function");
  });

  it("does not create a fallback auth instance without a secret", async () => {
    clearRuntimeConfiguration();
    const { getAuth } = await import("@/lib/auth");
    expect(() => getAuth()).toThrow(/AUTH_SECRET/);
  });
});

function clearRuntimeConfiguration() {
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_SECRET;
  delete process.env.APP_URL;
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
