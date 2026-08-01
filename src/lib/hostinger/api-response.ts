import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, isDiagnosticCode } from "@/lib/errors";

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const REFERENCE_ID_PATTERN = /^[a-f0-9]{12}$/;

export function apiSuccess<T>(data: T) {
  return NextResponse.json(
    { ok: true as const, data },
    { headers: noStoreHeaders },
  );
}

export function apiFailure(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false as const,
        error: {
          code: "VALIDATION_ERROR",
          message: "The request parameters are invalid.",
        },
      },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (error instanceof AppError) {
    const headers: Record<string, string> = { ...noStoreHeaders };
    const retryAfterSeconds =
      error.retryAfterSeconds ??
      (error.code === "RATE_LIMITED" ? 30 : undefined);
    if (retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(retryAfterSeconds);
    }
    return NextResponse.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message:
            error.code === "RATE_LIMITED"
              ? "Hostinger is temporarily rate limited. Retry in a few moments."
              : error.message,
          retryAfterSeconds:
            retryAfterSeconds,
          referenceId:
            error.referenceId &&
            REFERENCE_ID_PATTERN.test(error.referenceId)
              ? error.referenceId
              : undefined,
          diagnosticCode: isDiagnosticCode(error.diagnosticCode)
            ? error.diagnosticCode
            : undefined,
        },
      },
      { status: error.status, headers },
    );
  }
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "INTERNAL_ERROR",
        message: "The operation could not be completed.",
      },
    },
    { status: 500, headers: noStoreHeaders },
  );
}
