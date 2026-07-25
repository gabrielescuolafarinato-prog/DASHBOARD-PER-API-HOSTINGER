"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { requireOwner, requireSession } from "@/lib/auth/session";
import { createCollaborator, setUserActive } from "@/lib/team/service";
import { normalizeError } from "@/lib/errors";
import { passwordSchema } from "@/lib/auth/password-policy";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import { synchronizeConfiguredSite } from "@/lib/hostinger/site-sync";

export type ActionState = {
  ok: boolean;
  message?: string;
  code?: string;
  temporaryPassword?: string;
};

const collaboratorSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254),
});

export async function createCollaboratorAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const current = await requireOwner();
    const input = collaboratorSchema.parse({
      name: formData.get("name"),
      email: formData.get("email"),
    });
    const created = await createCollaborator({
      actorUserId: current.user.id,
      ...input,
    });
    revalidatePath("/team");
    return {
      ok: true,
      message: "Collaborator created. Copy the password now.",
      temporaryPassword: created.temporaryPassword,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, code: "VALIDATION_ERROR", message: error.issues[0].message };
    }
    return normalizeError(error);
  }
}

export async function setUserActiveAction(formData: FormData): Promise<ActionState> {
  try {
    const current = await requireOwner();
    const parsed = z
      .object({ userId: z.string().uuid(), active: z.enum(["true", "false"]) })
      .parse({ userId: formData.get("userId"), active: formData.get("active") });
    await setUserActive({
      actorUserId: current.user.id,
      targetUserId: parsed.userId,
      isActive: parsed.active === "true",
    });
    revalidatePath("/team");
    return { ok: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, code: "VALIDATION_ERROR", message: error.issues[0].message };
    }
    return normalizeError(error);
  }
}

export async function setUserActiveFormAction(formData: FormData): Promise<void> {
  await setUserActiveAction(formData);
}

export async function changePasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const current = await requireSession({ allowPasswordChange: true });
  try {
    const input = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: passwordSchema,
        confirmPassword: z.string(),
      })
      .refine((value) => value.newPassword === value.confirmPassword, {
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      })
      .parse({
        currentPassword: formData.get("currentPassword"),
        newPassword: formData.get("newPassword"),
        confirmPassword: formData.get("confirmPassword"),
      });

    await getAuth().api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
    await getDb()
      .update(user)
      .set({ mustChangePassword: false })
      .where(eq(user.id, current.user.id));
    await writeAuditEvent({
      actorUserId: current.user.id,
      operation: "auth.password.change",
      targetType: "user",
      targetIdentifier: current.user.email,
      result: "SUCCESS",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, code: "VALIDATION_ERROR", message: error.issues[0].message };
    }
    return normalizeError(error);
  }
  redirect("/overview");
}

export async function logoutAction() {
  const current = await requireSession({ allowPasswordChange: true });
  await writeAuditEvent({
    actorUserId: current.user.id,
    operation: "auth.logout",
    targetType: "session",
    result: "SUCCESS",
  });
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}

export async function syncHostingerSiteAction(): Promise<ActionState> {
  try {
    const current = await requireOwner();
    await synchronizeConfiguredSite(current.user.id);
    revalidatePath("/overview");
    revalidatePath("/site-settings");
    return { ok: true, message: "Hostinger configuration verified." };
  } catch (error) {
    return normalizeError(error);
  }
}

export async function syncHostingerSiteFormAction(): Promise<void> {
  await syncHostingerSiteAction();
}
