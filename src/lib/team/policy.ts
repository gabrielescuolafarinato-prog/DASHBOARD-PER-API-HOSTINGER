import { AppError } from "@/lib/errors";

export function assertEmailAvailable(existing: { id: string } | undefined) {
  if (existing) {
    throw new AppError("CONFLICT", "An account with this email already exists.", 409);
  }
}

export async function withAdministrativeAudit<T>(
  mutation: () => Promise<T>,
  audit: (result: "SUCCESS" | "FAILURE") => Promise<void>,
) {
  try {
    const result = await mutation();
    await audit("SUCCESS");
    return result;
  } catch (error) {
    await audit("FAILURE");
    throw error;
  }
}
