import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { passwordSchema } from "@/lib/auth/password-policy";
import { AppError } from "@/lib/errors";

const MAX_DATABASE_BODY_BYTES = 4_096;
const databaseIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().uuid();
const databaseSuffixSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_]*$/);
const specificIpSchema = z
  .string()
  .min(1)
  .max(45)
  .refine((value) => isIP(value) !== 0);

const createDatabaseSchema = z
  .object({
    nameSuffix: databaseSuffixSchema,
    userSuffix: databaseSuffixSchema,
    password: passwordSchema,
    passwordConfirmation: z.string(),
  })
  .strict()
  .refine(
    (value) => value.password === value.passwordConfirmation,
    { path: ["passwordConfirmation"] },
  );

const changePasswordSchema = z
  .object({
    password: passwordSchema,
    passwordConfirmation: z.string(),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    (value) => value.password === value.passwordConfirmation,
    { path: ["passwordConfirmation"] },
  );

const explicitConfirmationSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();

const deleteDatabaseSchema = z
  .object({
    confirmation: z.string().min(1).max(128),
    confirmed: z.literal(true),
  })
  .strict();

const remoteConnectionSchema = z
  .object({
    ip: specificIpSchema,
    confirmed: z.literal(true),
  })
  .strict();

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type ChangeDatabasePasswordInput = z.infer<
  typeof changePasswordSchema
>;
export type DeleteDatabaseInput = z.infer<typeof deleteDatabaseSchema>;
export type RemoteConnectionInput = z.infer<
  typeof remoteConnectionSchema
>;

export function parseDatabaseListSearchParams(
  searchParams: URLSearchParams,
) {
  assertOnlySearchParams(searchParams, new Set(["page", "per_page"]));
  return z
    .object({
      page: positiveInteger(1, 10_000).default(1),
      perPage: positiveInteger(1, 100).default(25),
    })
    .parse({
      page: searchParams.get("page") ?? undefined,
      perPage: searchParams.get("per_page") ?? undefined,
    });
}

export async function parseCreateDatabaseRequest(
  request: NextRequest,
) {
  return {
    input: createDatabaseSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export async function parseChangeDatabasePasswordRequest(
  request: NextRequest,
) {
  return {
    input: changePasswordSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export async function parseRepairDatabaseRequest(
  request: NextRequest,
) {
  return {
    input: explicitConfirmationSchema.parse(
      await readJsonBody(request),
    ),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export async function parseDeleteDatabaseRequest(
  request: NextRequest,
) {
  return {
    input: deleteDatabaseSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export async function parseRemoteConnectionRequest(
  request: NextRequest,
) {
  return {
    input: remoteConnectionSchema.parse(await readJsonBody(request)),
    idempotencyKey: parseIdempotencyKey(request),
  };
}

export function parseDatabaseId(value: string) {
  const parsed = databaseIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("NOT_FOUND", "Database not found.", 404);
  }
  return parsed.data;
}

export function parseEmptyDatabaseSearchParams(
  searchParams: URLSearchParams,
) {
  if ([...searchParams.keys()].length > 0) {
    throw invalidDatabaseRequest();
  }
  return z.object({}).strict().parse({});
}

export function assertSpecificIp(value: string) {
  const parsed = specificIpSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A specific IPv4 or IPv6 address is required.",
      400,
    );
  }
  return parsed.data;
}

async function readJsonBody(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].length > 0) {
    throw invalidDatabaseRequest();
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw invalidDatabaseRequest();
  }
  const text = await request.text();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_DATABASE_BODY_BYTES
  ) {
    throw invalidDatabaseRequest();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidDatabaseRequest();
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

function positiveInteger(min: number, max: number) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : value,
    z.number().int().min(min).max(max),
  );
}

function assertOnlySearchParams(
  searchParams: URLSearchParams,
  allowed: Set<string>,
) {
  if ([...searchParams.keys()].some((key) => !allowed.has(key))) {
    throw invalidDatabaseRequest();
  }
}

function invalidDatabaseRequest() {
  return new AppError(
    "VALIDATION_ERROR",
    "The database request is invalid.",
    400,
  );
}
