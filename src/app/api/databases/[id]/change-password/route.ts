import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseChangeDatabasePasswordRequest,
  parseDatabaseId,
} from "@/lib/hostinger/database-input";
import { changeDatabasePasswordForSite } from "@/lib/hostinger/database-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess(
      "database.password.change",
    );
    const databaseId = parseDatabaseId((await context.params).id);
    const { input, idempotencyKey } =
      await parseChangeDatabasePasswordRequest(request);
    const result = await changeDatabasePasswordForSite(
      current,
      databaseId,
      input,
      idempotencyKey,
    );
    revalidatePath("/databases");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
