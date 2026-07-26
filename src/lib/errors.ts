export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "HOSTINGER_ERROR"
  | "HOSTINGER_NOT_NODE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly referenceId?: string,
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
