import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseDatabaseId,
  parseRepairDatabaseRequest,
} from "@/lib/hostinger/database-input";
import { repairDatabaseForSite } from "@/lib/hostinger/database-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("database.repair");
    const databaseId = parseDatabaseId((await context.params).id);
    const { idempotencyKey } =
      await parseRepairDatabaseRequest(request);
    const result = await repairDatabaseForSite(
      current,
      databaseId,
      idempotencyKey,
    );
    revalidatePath("/databases");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
