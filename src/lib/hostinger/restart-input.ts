import { z } from "zod";
import type { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const emptyRestartBodySchema = z.object({}).strict();
const idempotencyKeySchema = z.string().uuid();
const MAX_RESTART_BODY_BYTES = 1_024;

export async function parseNodeRestartRequest(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].length > 0) {
    throw invalidRequest();
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") throw invalidRequest();

  const bodyText = await request.text();
  if (
    bodyText.length === 0 ||
    Buffer.byteLength(bodyText, "utf8") > MAX_RESTART_BODY_BYTES
  ) {
    throw invalidRequest();
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw invalidRequest();
  }
  if (!emptyRestartBodySchema.safeParse(body).success) {
    throw invalidRequest();
  }

  const idempotencyKey = idempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A valid idempotency key is required.",
      400,
    );
  }
  return { idempotencyKey: idempotencyKey.data };
}

function invalidRequest() {
  return new AppError(
    "VALIDATION_ERROR",
    "The restart request is invalid.",
    400,
  );
}
