import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";

const idempotencyKeySchema = z.string().uuid();
const cacheActionSchema = z
  .object({
    confirmed: z.literal(true),
  })
  .strict();
const cacheToggleSchema = z
  .object({
    enabled: z.boolean(),
    confirmed: z.literal(true),
  })
  .strict();

export async function parseCacheClearRequest(request: NextRequest) {
  return {
    input: cacheActionSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export async function parseCacheToggleRequest(request: NextRequest) {
  return {
    input: cacheToggleSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

async function readJsonBody(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].length > 0) {
    throw invalidRequest();
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim() !==
    "application/json"
  ) {
    throw invalidRequest();
  }
  const text = await request.text();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > 1_024
  ) {
    throw invalidRequest();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest();
  }
}

function parseIdempotencyKey(request: NextRequest) {
  const parsed = idempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key"),
  );
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A valid idempotency key is required.",
      400,
    );
  }
  return parsed.data;
}

function invalidRequest() {
  return new AppError(
    "VALIDATION_ERROR",
    "The cache request is invalid.",
    400,
  );
}
