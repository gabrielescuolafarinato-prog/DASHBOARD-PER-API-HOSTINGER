import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseEmptyDomainSearchParams } from "@/lib/hostinger/domain-input";
import { listDnsRecordsForSite } from "@/lib/hostinger/domain-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess("dns.records.list");
    parseEmptyDomainSearchParams(request.nextUrl.searchParams);
    return apiSuccess(await listDnsRecordsForSite(current));
  } catch (error) {
    return apiFailure(error);
  }
}
