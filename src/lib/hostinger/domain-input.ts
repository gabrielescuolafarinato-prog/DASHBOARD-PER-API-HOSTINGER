import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { officialDnsRecordTypes } from "./domain-types";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const idempotencyKeySchema = z.string().uuid();
const dnsRecordSchema = z
  .object({
    name: z.string().min(1).max(253),
    type: z.enum(officialDnsRecordTypes),
    content: z.string().min(1).max(16_384),
    ttl: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
const dnsCreateSchema = z
  .object({
    fingerprint: fingerprintSchema,
    record: dnsRecordSchema,
    confirmation: z.string().max(253).optional(),
  })
  .strict();
const dnsUpdateSchema = dnsCreateSchema
  .extend({ recordId: opaqueIdSchema })
  .strict();
const dnsDeleteSchema = z
  .object({
    fingerprint: fingerprintSchema,
    recordId: opaqueIdSchema.optional(),
    groupId: opaqueIdSchema,
    mode: z.enum(["record", "group"]),
    confirmation: z.string().min(1).max(300),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "record" && !value.recordId) {
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message: "A record identifier is required.",
      });
    }
  });
const subdomainCreateSchema = z
  .object({
    subdomain: z.string().min(1).max(253),
    directory: z.string().max(255).optional(),
    usePublicDirectory: z.boolean().optional(),
  })
  .strict();
const resourceDeleteSchema = z
  .object({
    resourceId: opaqueIdSchema,
    confirmation: z.string().min(1).max(253),
  })
  .strict();
const aliasCreateSchema = z
  .object({ alias: z.string().min(1).max(253) })
  .strict();

export type DnsCreateInput = z.infer<typeof dnsCreateSchema>;
export type DnsUpdateInput = z.infer<typeof dnsUpdateSchema>;
export type DnsDeleteInput = z.infer<typeof dnsDeleteSchema>;
export type SubdomainCreateInput = z.infer<typeof subdomainCreateSchema>;
export type ResourceDeleteInput = z.infer<typeof resourceDeleteSchema>;
export type AliasCreateInput = z.infer<typeof aliasCreateSchema>;

export function parseEmptyDomainSearchParams(searchParams: URLSearchParams) {
  if ([...searchParams.keys()].length > 0) throw invalidRequest();
}

export async function parseDnsCreateRequest(request: NextRequest) {
  return mutation(dnsCreateSchema, request);
}

export async function parseDnsUpdateRequest(request: NextRequest) {
  return mutation(dnsUpdateSchema, request);
}

export async function parseDnsDeleteRequest(request: NextRequest) {
  return mutation(dnsDeleteSchema, request);
}

export async function parseSubdomainCreateRequest(request: NextRequest) {
  return mutation(subdomainCreateSchema, request);
}

export async function parseSubdomainDeleteRequest(request: NextRequest) {
  return mutation(resourceDeleteSchema, request);
}

export async function parseAliasCreateRequest(request: NextRequest) {
  return mutation(aliasCreateSchema, request);
}

export async function parseAliasDeleteRequest(request: NextRequest) {
  return mutation(resourceDeleteSchema, request);
}

async function mutation<T extends z.ZodType>(schema: T, request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].length > 0) {
    throw invalidRequest();
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim() !==
    "application/json"
  ) {
    throw invalidRequest();
  }
  const raw = await request.text();
  if (raw.length === 0 || Buffer.byteLength(raw, "utf8") > 32_768) {
    throw invalidRequest();
  }
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
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
  return {
    input: schema.parse(body) as z.infer<T>,
    idempotencyKey: idempotencyKey.data,
  };
}

function invalidRequest() {
  return new AppError(
    "VALIDATION_ERROR",
    "The domain request is invalid.",
    400,
  );
}
