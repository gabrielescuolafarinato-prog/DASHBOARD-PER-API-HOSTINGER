import "server-only";
import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { session, siteMemberships, sites, user } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit";
import { assertEmailAvailable } from "./policy";

export function generateTemporaryPassword() {
  return `T!${randomBytes(18).toString("base64url")}7a`;
}

export async function createCollaborator(input: {
  actorUserId: string;
  name: string;
  email: string;
}) {
  const db = getDb();
  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  assertEmailAvailable(existing);

  const temporaryPassword = generateTemporaryPassword();
  try {
    const created = await getAuth().api.createUser({
      body: {
        name: input.name.trim(),
        email,
        password: temporaryPassword,
      },
      headers: await headers(),
    });

    await db
      .update(user)
      .set({ isActive: true, mustChangePassword: true, role: "COLLABORATOR" })
      .where(eq(user.id, created.user.id));

    const configuredSites = await db.select({ id: sites.id }).from(sites).limit(2);
    if (configuredSites.length === 1) {
      await db
        .insert(siteMemberships)
        .values({
          siteId: configuredSites[0].id,
          userId: created.user.id,
          role: "MEMBER",
        })
        .onConflictDoNothing();
    }

    await writeAuditEvent({
      actorUserId: input.actorUserId,
      siteId: configuredSites[0]?.id,
      operation: "team.user.create",
      targetType: "user",
      targetIdentifier: email,
      result: "SUCCESS",
      metadata: { role: "COLLABORATOR" },
    });
    return { userId: created.user.id, temporaryPassword };
  } catch (error) {
    await writeAuditEvent({
      actorUserId: input.actorUserId,
      operation: "team.user.create",
      targetType: "user",
      targetIdentifier: email,
      result: "FAILURE",
    });
    throw error;
  }
}

export async function setUserActive(input: {
  actorUserId: string;
  targetUserId: string;
  isActive: boolean;
}) {
  let targetEmail: string | undefined;
  try {
    if (input.actorUserId === input.targetUserId && !input.isActive) {
      throw new AppError("VALIDATION_ERROR", "You cannot disable your own account.", 422);
    }
    const db = getDb();
    const [target] = await db
      .select({ id: user.id, email: user.email, role: user.role })
      .from(user)
      .where(eq(user.id, input.targetUserId))
      .limit(1);
    if (!target) throw new AppError("NOT_FOUND", "User not found.", 404);
    targetEmail = target.email;
    if (target.role === "OWNER") {
      throw new AppError("FORBIDDEN", "Owner accounts cannot be changed here.", 403);
    }

    await db
      .update(user)
      .set({
        isActive: input.isActive,
        banned: !input.isActive,
        banReason: input.isActive ? null : "Disabled by owner",
        banExpires: null,
      })
      .where(and(eq(user.id, target.id), eq(user.role, "COLLABORATOR")));

    if (!input.isActive) {
      await db.delete(session).where(eq(session.userId, target.id));
    }
    await writeAuditEvent({
      actorUserId: input.actorUserId,
      operation: input.isActive ? "team.user.enable" : "team.user.disable",
      targetType: "user",
      targetIdentifier: target.email,
      result: "SUCCESS",
    });
  } catch (error) {
    await writeAuditEvent({
      actorUserId: input.actorUserId,
      operation: input.isActive ? "team.user.enable" : "team.user.disable",
      targetType: "user",
      targetIdentifier: targetEmail ?? input.targetUserId,
      result: error instanceof AppError && error.status === 403 ? "DENIED" : "FAILURE",
    });
    throw error;
  }
}
