import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseNodeRestartRequest } from "@/lib/hostinger/restart-input";
import { restartNodeServerForSite } from "@/lib/hostinger/restart-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("node.restart");
    const input = await parseNodeRestartRequest(request);
    const result = await restartNodeServerForSite(
      current,
      input.idempotencyKey,
    );
    revalidatePath("/overview");
    revalidatePath("/builds");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
