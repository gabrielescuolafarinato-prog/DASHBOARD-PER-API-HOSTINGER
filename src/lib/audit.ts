import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";

const forbiddenMetadataKeys =
  /token|password|secret|authorization|cookie|connectionstring|stack|headers|raw|response|bearer|payload|username|domain|url|query|message/i;
const secretLikeValue =
  /(?:bearer\s+[^\s]+|postgres(?:ql)?:\/\/|https?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

export function sanitizeAuditMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeObject(metadata, 0);
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth > 4) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !forbiddenMetadataKeys.test(key))
      .flatMap(([key, item]) => {
        const sanitized = sanitizeValue(item, depth + 1);
        return sanitized === undefined ? [] : [[key, sanitized]];
      }),
  );
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return secretLikeValue.test(value) ? "[REDACTED]" : value.slice(0, 500);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>, depth);
  }
  return undefined;
}

export function hashAuditIdentifier(value?: string) {
  return value
    ? createHash("sha256").update(value.trim().toLowerCase()).digest("hex")
    : undefined;
}

export async function writeAuditEvent(input: {
  actorUserId?: string | null;
  siteId?: string | null;
  operation: string;
  targetType: string;
  targetIdentifier?: string;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  metadata?: Record<string, unknown>;
}) {
  await getDb().insert(auditEvents).values({
    actorUserId: input.actorUserId,
    siteId: input.siteId,
    operation: input.operation,
    targetType: input.targetType,
    targetIdentifierHash: hashAuditIdentifier(input.targetIdentifier),
    result: input.result,
    metadata: sanitizeAuditMetadata(input.metadata),
  });
}
