import { describe, expect, it } from "vitest";
import {
  getApplicationSetupStatus,
  getHostingerConfigurationState,
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
      hostinger: { status: "unconfigured", configured: false },
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

  it("reports partial Hostinger configuration without exposing values", () => {
    expect(
      getHostingerConfigurationState({
        HOSTINGER_API_TOKEN: "must-not-be-returned",
      }),
    ).toEqual({ status: "incomplete", configured: false });
    expect(
      JSON.stringify(
        getHostingerConfigurationState({
          HOSTINGER_API_TOKEN: "must-not-be-returned",
        }),
      ),
    ).not.toContain("must-not-be-returned");
  });

  it("accepts Hostinger as entirely unconfigured", () => {
    expect(parseHostingerEnv({})).toEqual({});
    expect(getHostingerConfigurationState({})).toEqual({
      status: "unconfigured",
      configured: false,
    });
  });

  it("accepts and safely publishes a complete Hostinger group", () => {
    const source = {
      HOSTINGER_API_TOKEN: "server-secret",
      HOSTINGER_ACCOUNT_USERNAME: "u123456",
      HOSTINGER_SITE_DOMAIN: " MÜNICH.Example. ",
    };
    expect(parseHostingerEnv(source)).toEqual({
      HOSTINGER_API_TOKEN: "server-secret",
      HOSTINGER_ACCOUNT_USERNAME: "u123456",
      HOSTINGER_SITE_DOMAIN: "xn--mnich-kva.example",
    });
    const publicState = getHostingerConfigurationState(source);
    expect(publicState).toEqual({
      status: "ready",
      configured: true,
      domain: "xn--mnich-kva.example",
    });
    expect(JSON.stringify(publicState)).not.toContain("server-secret");
    expect(JSON.stringify(publicState)).not.toContain("u123456");
  });

  it("parses optional phpMyAdmin host suffix pinning server-side", () => {
    expect(
      parseHostingerEnv({
        HOSTINGER_API_TOKEN: "server-secret",
        HOSTINGER_ACCOUNT_USERNAME: "u123456",
        HOSTINGER_SITE_DOMAIN: "example.com",
        HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES:
          "public-provider.net,secure.public-provider.net,public-provider.net",
      }),
    ).toEqual({
      HOSTINGER_API_TOKEN: "server-secret",
      HOSTINGER_ACCOUNT_USERNAME: "u123456",
      HOSTINGER_SITE_DOMAIN: "example.com",
      HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES: [
        "public-provider.net",
        "secure.public-provider.net",
      ],
    });
    const publicState = getHostingerConfigurationState({
      HOSTINGER_API_TOKEN: "server-secret",
      HOSTINGER_ACCOUNT_USERNAME: "u123456",
      HOSTINGER_SITE_DOMAIN: "example.com",
      HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES:
        "public-provider.net",
    });
    expect(publicState).toEqual({
      status: "ready",
      configured: true,
      domain: "example.com",
    });
    expect(JSON.stringify(publicState)).not.toContain(
      "public-provider.net",
    );
  });

  it.each([
    "https://public-provider.net",
    "*.public-provider.net",
    "public-provider.net/path",
    "public-provider.net:443",
    "PUBLIC-PROVIDER.NET",
    "localhost",
    "127.0.0.1",
    "db.internal",
    "public-provider.net,",
  ])("fails closed for malformed phpMyAdmin pinning %s", (value) => {
    expect(() =>
      parseHostingerEnv({
        HOSTINGER_API_TOKEN: "server-secret",
        HOSTINGER_ACCOUNT_USERNAME: "u123456",
        HOSTINGER_SITE_DOMAIN: "example.com",
        HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES: value,
      }),
    ).toThrow(/lowercase public ASCII DNS suffixes/);
  });

  it("reports malformed standalone pinning as incomplete without publishing it", () => {
    const state = getHostingerConfigurationState({
      HOSTINGER_PHPMYADMIN_ALLOWED_HOST_SUFFIXES:
        "https://must-not-be-published.invalid",
    });
    expect(state).toEqual({
      status: "incomplete",
      configured: false,
    });
    expect(JSON.stringify(state)).not.toContain("must-not-be-published");
  });

  it.each([
    "https://example.com",
    "*.example.com",
    "example.com/path",
    "example.com:443",
    "user@example.com",
  ])("reports invalid complete Hostinger domain %s", (domain) => {
    const state = getHostingerConfigurationState({
      HOSTINGER_API_TOKEN: "server-secret",
      HOSTINGER_ACCOUNT_USERNAME: "u123456",
      HOSTINGER_SITE_DOMAIN: domain,
    });
    expect(state).toEqual({ status: "invalid", configured: false });
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
