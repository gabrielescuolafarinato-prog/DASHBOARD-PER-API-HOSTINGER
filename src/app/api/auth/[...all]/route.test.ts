import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.AUTH_SECRET;
const originalAppUrl = process.env.APP_URL;

afterEach(() => {
  restore("DATABASE_URL", originalDatabaseUrl);
  restore("AUTH_SECRET", originalAuthSecret);
  restore("APP_URL", originalAppUrl);
});

describe("auth route before application setup", () => {
  it("returns a generic 503 response without configuration", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.APP_URL;

    const response = await GET(
      new Request("http://localhost:3000/api/auth/get-session"),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: {
        code: "SETUP_REQUIRED",
        message: "Server configuration is required.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(body)).not.toContain("AUTH_SECRET");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
