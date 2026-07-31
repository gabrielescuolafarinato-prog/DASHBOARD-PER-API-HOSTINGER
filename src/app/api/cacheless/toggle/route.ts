import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseCacheToggleRequest } from "@/lib/hostinger/cache-input";
import { toggleCachelessModeForSite } from "@/lib/hostinger/cache-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess(
      "site.cacheless.toggle",
    );
    const { input, idempotencyKey } =
      await parseCacheToggleRequest(request);
    const result = await toggleCachelessModeForSite(
      current,
      input.enabled,
      idempotencyKey,
    );
    revalidatePath("/site-tools");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
