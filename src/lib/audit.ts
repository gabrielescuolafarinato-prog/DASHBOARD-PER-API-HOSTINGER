import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";

const forbiddenMetadataKeys = /token|password|secret|authorization|cookie/i;

export function sanitizeAuditMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !forbiddenMetadataKeys.test(key)),
  );
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
