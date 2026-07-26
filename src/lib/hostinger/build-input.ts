import { z } from "zod";

export const buildListInputSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const buildLogInputSchema = z
  .object({
    uuid: z.string().uuid(),
    fromLine: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();

const buildListQuerySchema = z
  .object({
    page: z.string().optional(),
    per_page: z.string().optional(),
  })
  .strict();

const buildLogQuerySchema = z
  .object({
    from_line: z.string().optional(),
  })
  .strict();

export function parseBuildListSearchParams(searchParams: URLSearchParams) {
  const query = buildListQuerySchema.parse(
    Object.fromEntries(searchParams.entries()),
  );
  return buildListInputSchema.parse({
    page: query.page,
    perPage: query.per_page,
  });
}

export function parseBuildLogSearchParams(
  uuid: string,
  searchParams: URLSearchParams,
) {
  const query = buildLogQuerySchema.parse(
    Object.fromEntries(searchParams.entries()),
  );
  return buildLogInputSchema.parse({
    uuid,
    fromLine: query.from_line,
  });
}
