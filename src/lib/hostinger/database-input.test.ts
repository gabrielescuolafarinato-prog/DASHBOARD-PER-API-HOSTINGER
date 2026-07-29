import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  assertSpecificIp,
  parseChangeDatabasePasswordRequest,
  parseCreateDatabaseRequest,
  parseDeleteDatabaseRequest,
  parseRemoteConnectionRequest,
  parseRepairDatabaseRequest,
} from "./database-input";

const key = "33333333-3333-4333-8333-333333333333";
const password = "Strong-password-123!";

describe("database application request boundary", () => {
  it("accepts only suffixes and password fields from the browser", async () => {
    await expect(
      parseCreateDatabaseRequest(
        request("/api/databases", {
          nameSuffix: "shop",
          userSuffix: "app_user",
          password,
          passwordConfirmation: password,
        }),
      ),
    ).resolves.toEqual({
      input: {
        nameSuffix: "shop",
        userSuffix: "app_user",
        password,
        passwordConfirmation: password,
      },
      idempotencyKey: key,
    });
  });

  it.each([
    { website_domain: "other.example" },
    { domain: "other.example" },
    { username: "other-account" },
    { name: "u1_full_name" },
    { user: "u1_full_user" },
  ])("rejects browser-controlled authoritative field %j", async (extra) => {
    await expect(
      parseCreateDatabaseRequest(
        request("/api/databases", {
          nameSuffix: "shop",
          userSuffix: "app",
          password,
          passwordConfirmation: password,
          ...extra,
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("requires matching strong passwords and explicit confirmation for a change", async () => {
    await expect(
      parseChangeDatabasePasswordRequest(
        request("/api/databases/id/change-password", {
          password,
          passwordConfirmation: password,
          confirmed: true,
        }),
      ),
    ).resolves.toMatchObject({ idempotencyKey: key });
    await expect(
      parseChangeDatabasePasswordRequest(
        request("/api/databases/id/change-password", {
          password,
          passwordConfirmation: "Different-password-456!",
          confirmed: true,
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      parseChangeDatabasePasswordRequest(
        request("/api/databases/id/change-password", {
          password,
          passwordConfirmation: password,
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("requires explicit confirmation for repair and exact-name input for delete", async () => {
    await expect(
      parseRepairDatabaseRequest(
        request("/api/databases/id/repair", { confirmed: true }),
      ),
    ).resolves.toMatchObject({ idempotencyKey: key });
    await expect(
      parseRepairDatabaseRequest(
        request("/api/databases/id/repair", {}),
      ),
    ).rejects.toBeDefined();
    await expect(
      parseDeleteDatabaseRequest(
        request("/api/databases/id", {
          confirmation: "u1_shop",
          confirmed: true,
        }, "DELETE"),
      ),
    ).resolves.toMatchObject({
      input: { confirmation: "u1_shop", confirmed: true },
    });
    await expect(
      parseDeleteDatabaseRequest(
        request("/api/databases/id", {
          confirmation: "u1_shop",
        }, "DELETE"),
      ),
    ).rejects.toBeDefined();
  });

  it.each(["192.0.2.10", "2001:db8::1"])(
    "accepts a specific IP address %s",
    async (ip) => {
      expect(assertSpecificIp(ip)).toBe(ip);
      await expect(
        parseRemoteConnectionRequest(
          request("/api/databases/id/remote-connections", {
            ip,
            confirmed: true,
          }),
        ),
      ).resolves.toMatchObject({ input: { ip, confirmed: true } });
    },
  );

  it.each([
    "%",
    "*",
    "0.0.0.0/0",
    "2001:db8::/64",
    "database.example",
    "192.0.2.10%",
  ])("rejects wildcard, CIDR or hostname input %s", async (ip) => {
    expect(() => assertSpecificIp(ip)).toThrow();
    await expect(
      parseRemoteConnectionRequest(
        request("/api/databases/id/remote-connections", {
          ip,
          confirmed: true,
        }),
      ),
    ).rejects.toBeDefined();
  });
});

function request(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
) {
  return new NextRequest(`https://console.test${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
