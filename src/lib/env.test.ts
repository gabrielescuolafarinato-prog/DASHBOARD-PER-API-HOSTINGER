import { describe, expect, it } from "vitest";
import {
  getApplicationSetupStatus,
  getRuntimeEnv,
  parseCoreEnv,
  parseHostingerEnv,
  ServerEnvironmentError,
} from "./env";

describe("environment validation", () => {
  it("reports missing required core values", () => {
    expect(() => parseCoreEnv({})).toThrow(/DATABASE_URL/);
  });

  it("fails lazily when runtime configuration is requested", () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousAuthSecret = process.env.AUTH_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    try {
      expect(() => getRuntimeEnv()).toThrow(ServerEnvironmentError);
      expect(() => getRuntimeEnv()).toThrow(/DATABASE_URL/);
    } finally {
      restoreEnvironmentValue("DATABASE_URL", previousDatabaseUrl);
      restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    }
  });

  it("reports setup required without inventing an auth secret", () => {
    expect(getApplicationSetupStatus({})).toEqual({
      applicationConfigured: false,
      databaseConfigured: false,
      authenticationConfigured: false,
      hostingerConfigured: false,
    });
  });

  it("does not invent an application origin when APP_URL is absent", () => {
    const status = getApplicationSetupStatus({
      DATABASE_URL:
        "postgresql://user:password@db.example.invalid/database?sslmode=require",
      AUTH_SECRET: "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ",
      NODE_ENV: "development",
    });
    expect(status.applicationConfigured).toBe(false);
    expect(status.authenticationConfigured).toBe(false);
  });

  it("rejects a partial Hostinger configuration", () => {
    expect(() =>
      parseHostingerEnv({ HOSTINGER_API_TOKEN: "secret" }),
    ).toThrow(/must be configured together/);
  });

  it("accepts Hostinger as entirely unconfigured", () => {
    expect(parseHostingerEnv({})).toEqual({});
  });

  it("rejects the documented secret placeholder", () => {
    expect(() =>
      parseCoreEnv({
        DATABASE_URL:
          "postgresql://user:password@db.example.invalid/database?sslmode=require",
        AUTH_SECRET: "replace-with-at-least-32-random-characters",
        APP_URL: "http://localhost:3000",
        NODE_ENV: "development",
      }),
    ).toThrow(/high-entropy/);
  });

  it("accepts a complete runtime configuration", () => {
    const result = parseCoreEnv({
      DATABASE_URL:
        "postgresql://user:password@db.example.invalid/database?sslmode=require",
      AUTH_SECRET: "test-only-9A7dK3mP8qR2vX6zN4sT1wY5bC0eF7hJ",
      APP_URL: "https://console.example.com",
      NODE_ENV: "production",
    });
    expect(result.APP_URL).toBe("https://console.example.com");
  });
});

function restoreEnvironmentValue(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
