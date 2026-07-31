import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseCacheClearRequest } from "@/lib/hostinger/cache-input";
import { clearCacheForSite } from "@/lib/hostinger/cache-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("site.cache.clear");
    const { idempotencyKey } = await parseCacheClearRequest(request);
    const result = await clearCacheForSite(current, idempotencyKey);
    revalidatePath("/site-tools");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
