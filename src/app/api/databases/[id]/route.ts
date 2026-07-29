import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseDatabaseId,
  parseDeleteDatabaseRequest,
} from "@/lib/hostinger/database-input";
import { deleteDatabaseForSite } from "@/lib/hostinger/database-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("database.delete");
    const databaseId = parseDatabaseId((await context.params).id);
    const { input, idempotencyKey } =
      await parseDeleteDatabaseRequest(request);
    const result = await deleteDatabaseForSite(
      current,
      databaseId,
      input,
      idempotencyKey,
    );
    revalidatePath("/databases");
    revalidatePath("/overview");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
