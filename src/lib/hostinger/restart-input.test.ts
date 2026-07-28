import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { parseNodeRestartRequest } from "./restart-input";

const idempotencyKey = "33333333-3333-4333-8333-333333333333";

describe("Node.js restart browser input", () => {
  it("accepts only an empty JSON object and a UUID idempotency header", async () => {
    await expect(
      parseNodeRestartRequest(request({})),
    ).resolves.toEqual({ idempotencyKey });
  });

  it.each([
    { username: "browser-user" },
    { domain: "attacker.example" },
    { site_id: "11111111-1111-4111-8111-111111111111" },
    { url: "https://attacker.example" },
    { method: "DELETE" },
    { order_id: "order-1" },
    { token: "private-token" },
  ])("rejects browser-controlled target field %#", async (body) => {
    await expect(parseNodeRestartRequest(request(body))).rejects.toMatchObject(
      { code: "VALIDATION_ERROR", status: 400 },
    );
  });

  it("rejects query parameters, invalid content type and invalid UUID", async () => {
    await expect(
      parseNodeRestartRequest(
        request({}, { url: "?domain=attacker.example" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parseNodeRestartRequest(
        request({}, { contentType: "text/plain" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parseNodeRestartRequest(request({}, { key: "not-a-uuid" })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

function request(
  body: unknown,
  options?: {
    key?: string;
    contentType?: string;
    url?: string;
  },
) {
  return new NextRequest(
    `https://console.test/api/node/restart${options?.url ?? ""}`,
    {
      method: "POST",
      headers: {
        "Content-Type": options?.contentType ?? "application/json",
        "Idempotency-Key": options?.key ?? idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}
