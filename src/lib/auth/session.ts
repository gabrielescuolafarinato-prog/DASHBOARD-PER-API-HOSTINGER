import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { getApplicationSetupStatus } from "@/lib/env";
import { isAccountActive, requiresPasswordChange } from "./session-policy";

export const getValidatedSession = cache(async () => {
  if (!getApplicationSetupStatus().applicationConfigured) return null;

  const current = await getAuth().api.getSession({ headers: await headers() });
  if (!current) return null;

  const [record] = await getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
    })
    .from(user)
    .where(eq(user.id, current.user.id))
    .limit(1);

  if (!isAccountActive(record)) return null;
  return { session: current.session, user: record };
});

export async function requireSession(options?: { allowPasswordChange?: boolean }) {
  if (!getApplicationSetupStatus().applicationConfigured) {
    redirect("/setup-required");
  }
  const current = await getValidatedSession();
  if (!current) redirect("/login");
  if (requiresPasswordChange(current.user) && !options?.allowPasswordChange) {
    redirect("/change-password");
  }
  return current;
}

export async function requireOwner(options?: { allowPasswordChange?: boolean }) {
  const current = await requireSession(options);
  if (current.user.role !== "OWNER") {
    throw new AppError("FORBIDDEN", "Owner access is required.", 403);
  }
  return current;
}
