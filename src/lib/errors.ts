export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "HOSTINGER_ERROR"
  | "HOSTINGER_NOT_NODE"
  | "DATABASE_MIGRATION_REQUIRED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export const diagnosticCodes = [
  "PHPMYADMIN_RESPONSE_SHAPE",
  "PHPMYADMIN_MISSING_LINK",
  "PHPMYADMIN_AMBIGUOUS_LINK",
  "PHPMYADMIN_INVALID_PROTOCOL",
  "PHPMYADMIN_URL_CREDENTIALS",
  "PHPMYADMIN_INVALID_PORT",
  "PHPMYADMIN_FRAGMENT",
  "PHPMYADMIN_MALFORMED_URL",
  "PHPMYADMIN_INVALID_PUBLIC_HOSTNAME",
  "PHPMYADMIN_IP_LITERAL",
  "PHPMYADMIN_LOCAL_HOSTNAME",
  "PHPMYADMIN_BLOCKED_SUFFIX",
  "PHPMYADMIN_INVALID_DNS_SYNTAX",
  "PHPMYADMIN_CONFIGURED_HOST_NOT_ALLOWED",
  "PHPMYADMIN_UPSTREAM",
  "PHPMYADMIN_LIVE_VERIFICATION",
] as const;

export type DiagnosticCode = (typeof diagnosticCodes)[number];

export function isDiagnosticCode(
  value: unknown,
): value is DiagnosticCode {
  return (
    typeof value === "string" &&
    diagnosticCodes.includes(value as DiagnosticCode)
  );
}

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly referenceId?: string,
    public readonly retryAfterSeconds?: number,
    public readonly diagnosticCode?: DiagnosticCode,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function normalizeError(error: unknown) {
  if (error instanceof AppError) {
    return { ok: false as const, code: error.code, message: error.message };
  }
  return {
    ok: false as const,
    code: "INTERNAL_ERROR" as const,
    message: "The operation could not be completed.",
  };
}
