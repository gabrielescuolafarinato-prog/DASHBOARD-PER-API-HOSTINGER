import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import {
  createDatabaseForSite,
  listDatabasesForSite,
} from "@/lib/hostinger/database-service";
import {
  parseCreateDatabaseRequest,
  parseDatabaseListSearchParams,
} from "@/lib/hostinger/database-input";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess("database.list");
    const pagination = parseDatabaseListSearchParams(
      request.nextUrl.searchParams,
    );
    return apiSuccess(
      await listDatabasesForSite(current, pagination),
    );
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("database.create");
    const { input, idempotencyKey } =
      await parseCreateDatabaseRequest(request);
    const result = await createDatabaseForSite(
      current,
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
