"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import {
  requireOwner,
  requireOwnerOnboarding,
  requireSession,
} from "@/lib/auth/session";
import { createCollaborator, setUserActive } from "@/lib/team/service";
import { AppError, normalizeError } from "@/lib/errors";
import { passwordSchema } from "@/lib/auth/password-policy";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { writeAuditEvent } from "@/lib/audit";
import {
  importVerifiedConfiguredSite,
  logRecoveredImportIssue,
  precheckConfiguredHostingerSite,
  reportUnexpectedImportFailure,
  verifyConfiguredHostingerSite,
  type HostingerSiteImportOutcome,
  type HostingerVerificationFailureCode,
} from "@/lib/hostinger/site-sync";
import {
  getHostingerConfigurationState,
} from "@/lib/env";
import { normalizeDomain } from "@/lib/hostinger/domain";

export type ActionState = {
  ok: boolean;
  message?: string;
  code?: string;
  temporaryPassword?: string;
};

export type HostingerVerificationActionState = ActionState & {
  status: "idle" | "verified" | "error";
  site?: {
    domain: string;
    siteStatus: "VERIFIED";
    nodeEnabled: true;
    orderId?: string;
  };
};

export type HostingerImportActionState =
  | { ok: false; status: "idle" }
  | {
      ok: false;
      status: "error";
      code:
        | "CONFIRMATION_MISMATCH"
        | "CONFIGURATION_INCOMPLETE"
        | "CONFIGURATION_INVALID"
        | "FORBIDDEN"
        | "HOSTINGER_SITE_NOT_FOUND"
        | "HOSTINGER_NOT_NODE"
        | "HOSTINGER_RATE_LIMITED"
        | "HOSTINGER_ERROR"
        | "SINGLE_SITE_CONFLICT"
        | "DATABASE_IMPORT_FAILED"
        | "RESULT_DECODE_FAILED"
        | "POSTCONDITION_FAILED"
        | "INTERNAL_ERROR";
      message: string;
      referenceId?: string;
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

export async function verifyHostingerSiteAction(
  _previous: HostingerVerificationActionState,
  _formData: FormData,
): Promise<HostingerVerificationActionState> {
  void _previous;
  void _formData;
  // This guard may redirect. It intentionally stays outside the application
  // error catch so Next.js control-flow exceptions are never normalized.
  const current = await requireOwnerOnboarding();
  try {
    if (current.user.role !== "OWNER" || current.user.isActive !== true) {
      return {
        ok: false,
        status: "error",
        code: "FORBIDDEN",
        message: "Only the active OWNER can verify the configured site.",
      };
    }
    const verified = await verifyConfiguredHostingerSite(current.user.id);
    return {
      ok: true,
      status: "verified",
      message: "Sito Hostinger verificato. Conferma prima dell’importazione.",
      site: {
        domain: verified.domain,
        siteStatus: verified.siteStatus,
        nodeEnabled: verified.nodeEnabled,
        orderId: verified.orderId,
      },
    };
  } catch (error) {
    const configuration = getHostingerConfigurationState();
    const outcome = await mapHostingerVerificationError({
      actorUserId: current.user.id,
      domain: configuration.configured
        ? configuration.domain
        : "configured-site",
      error,
    });
    const mapped = mapImportOutcomeToActionState(
      outcome.type === "verification_failed" ||
        outcome.type === "persistence_failed"
        ? outcome
        : {
            type: "verification_failed",
            code: "HOSTINGER_ERROR",
          },
    );
    return {
      ok: false,
      status: "error",
      code: mapped.status === "error" ? mapped.code : "INTERNAL_ERROR",
      message:
        mapped.status === "error"
          ? mapped.message
          : "La verifica Hostinger non è stata completata.",
    };
  }
}

export async function importHostingerSiteAction(
  _previous: HostingerImportActionState,
  formData: FormData,
): Promise<HostingerImportActionState> {
  void _previous;
  // An OWNER may legitimately call this action after the atomic write has
  // completed. requireOwnerOnboarding would redirect in that state, so use the
  // session boundary and let the authoritative precheck prove idempotency.
  // This call can redirect and therefore must remain outside the catch below.
  const current = await requireSession();
  let outcome: HostingerSiteImportOutcome | undefined;

  try {
    if (current.user.role !== "OWNER" || current.user.isActive !== true) {
      return {
        ok: false,
        status: "error",
        code: "FORBIDDEN",
        message: "Solo l’OWNER attivo può completare l’importazione.",
      };
    }

    const configuration = getHostingerConfigurationState();
    if (!configuration.configured) {
      return {
        ok: false,
        status: "error",
        code:
          configuration.status === "incomplete"
            ? "CONFIGURATION_INCOMPLETE"
            : "CONFIGURATION_INVALID",
        message:
          configuration.status === "incomplete"
            ? "La configurazione Hostinger è incompleta."
            : "La configurazione Hostinger non è valida.",
      };
    }

    const precheck = await precheckConfiguredHostingerSite(current.user.id);
    if (precheck.type !== "ready") {
      outcome = precheck;
    } else {
      const confirmation = z.string().max(253).parse(
        formData.get("confirmationDomain"),
      );
      let confirmedDomain: string;
      try {
        confirmedDomain = normalizeDomain(confirmation);
      } catch {
        confirmedDomain = "";
      }
      if (confirmedDomain !== configuration.domain) {
        await writeAuditEvent({
          actorUserId: current.user.id,
          operation: "hostinger_site_import_conflict",
          targetType: "site",
          targetIdentifier: configuration.domain,
          result: "DENIED",
          metadata: { reason: "confirmation_mismatch" },
        });
        return {
          ok: false,
          status: "error",
          code: "CONFIRMATION_MISMATCH",
          message:
            "Il dominio di conferma non corrisponde al sito configurato.",
        };
      }

      // Discovery and Node.js capability are deliberately repeated immediately
      // before the atomic write. Browser fields never select the target.
      let verified:
        | Awaited<ReturnType<typeof verifyConfiguredHostingerSite>>
        | undefined;
      try {
        verified = await verifyConfiguredHostingerSite(current.user.id);
      } catch (error) {
        outcome = await mapHostingerVerificationError({
          actorUserId: current.user.id,
          domain: configuration.domain,
          error,
        });
      }

      if (verified) {
        outcome = await importVerifiedConfiguredSite(
          current.user.id,
          verified,
        );
      }
    }
    if (!outcome) {
      throw new Error("Hostinger import did not resolve an outcome.");
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        status: "error",
        code: "CONFIRMATION_MISMATCH",
        message: "Inserisci il dominio configurato per confermare.",
      };
    }
    const configuration = getHostingerConfigurationState();
    outcome = await reportUnexpectedImportFailure({
      actorUserId: current.user.id,
      domain: configuration.configured
        ? configuration.domain
        : "configured-site",
      phase: "database_import",
      error,
    });
  }

  if (outcome.type === "imported" || outcome.type === "already_imported") {
    try {
      revalidatePath("/overview");
      revalidatePath("/onboarding");
      revalidatePath("/site-settings");
      revalidatePath("/", "layout");
    } catch (error) {
      logRecoveredImportIssue({ phase: "redirect", error });
    }
    // redirect() throws NEXT_REDIRECT. Keeping it after every catch is the
    // central guarantee: successful and idempotent imports always navigate.
    redirect("/overview");
  }

  return mapImportOutcomeToActionState(outcome);
}

async function mapHostingerVerificationError(input: {
  actorUserId: string;
  domain: string;
  error: unknown;
}): Promise<HostingerSiteImportOutcome> {
  if (input.error instanceof AppError) {
    let code: HostingerVerificationFailureCode;
    if (input.error.code === "NOT_FOUND") code = "SITE_NOT_FOUND";
    else if (input.error.code === "HOSTINGER_NOT_NODE") code = "NOT_NODE_JS";
    else if (input.error.code === "RATE_LIMITED") code = "RATE_LIMITED";
    else if (
      input.error.code === "HOSTINGER_ERROR" ||
      input.error.code === "CONFLICT"
    ) {
      code = "HOSTINGER_ERROR";
    }
    else {
      return reportUnexpectedImportFailure({
        actorUserId: input.actorUserId,
        domain: input.domain,
        phase: "hostinger_reverification",
        error: input.error,
        correlationId: input.error.correlationId,
      });
    }
    return { type: "verification_failed", code };
  }
  return reportUnexpectedImportFailure({
    actorUserId: input.actorUserId,
    domain: input.domain,
    phase: "hostinger_reverification",
    error: input.error,
  });
}

function mapImportOutcomeToActionState(
  outcome: Exclude<
    HostingerSiteImportOutcome,
    { type: "imported" | "already_imported" }
  >,
): HostingerImportActionState {
  if (outcome.type === "single_site_conflict") {
    return {
      ok: false,
      status: "error",
      code: "SINGLE_SITE_CONFLICT",
      message:
        "L’importazione è in conflitto con lo stato single-site esistente.",
    };
  }
  if (outcome.type === "verification_failed") {
    const values: Record<
      HostingerVerificationFailureCode,
      {
        code: Extract<
          HostingerImportActionState,
          { status: "error" }
        >["code"];
        message: string;
      }
    > = {
      SITE_NOT_FOUND: {
        code: "HOSTINGER_SITE_NOT_FOUND",
        message: "Il sito configurato non è più stato trovato su Hostinger.",
      },
      NOT_NODE_JS: {
        code: "HOSTINGER_NOT_NODE",
        message: "Il sito configurato non risulta più abilitato a Node.js.",
      },
      RATE_LIMITED: {
        code: "HOSTINGER_RATE_LIMITED",
        message:
          "Hostinger ha applicato un limite temporaneo. Riprova tra poco.",
      },
      HOSTINGER_ERROR: {
        code: "HOSTINGER_ERROR",
        message:
          "La verifica Hostinger non è stata completata. Riprova tra poco.",
      },
    };
    return { ok: false, status: "error", ...values[outcome.code] };
  }

  const code =
    outcome.phase === "result_decode"
      ? "RESULT_DECODE_FAILED"
      : outcome.phase === "postcondition"
        ? "POSTCONDITION_FAILED"
        : outcome.phase === "hostinger_reverification"
          ? "INTERNAL_ERROR"
          : "DATABASE_IMPORT_FAILED";
  return {
    ok: false,
    status: "error",
    code,
    referenceId: outcome.referenceId,
    message: `Importazione non completata. Riferimento: ${outcome.referenceId}`,
  };
}
