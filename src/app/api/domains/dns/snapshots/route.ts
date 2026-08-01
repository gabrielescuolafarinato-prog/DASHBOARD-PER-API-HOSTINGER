import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseEmptyDomainSearchParams } from "@/lib/hostinger/domain-input";
import { listDnsSnapshotsForSite } from "@/lib/hostinger/domain-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess("dns.snapshots.list");
    parseEmptyDomainSearchParams(request.nextUrl.searchParams);
    return apiSuccess(await listDnsSnapshotsForSite(current));
  } catch (error) {
    return apiFailure(error);
  }
}
