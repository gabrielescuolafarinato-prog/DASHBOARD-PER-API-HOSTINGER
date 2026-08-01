import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseEmptyDomainSearchParams } from "@/lib/hostinger/domain-input";
import { getDnsSnapshotForSite } from "@/lib/hostinger/domain-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const current = await requireHostingerApiAccess("dns.snapshots.view");
    parseEmptyDomainSearchParams(request.nextUrl.searchParams);
    return apiSuccess(
      await getDnsSnapshotForSite(current, (await context.params).id),
    );
  } catch (error) {
    return apiFailure(error);
  }
}
