import type { NextRequest } from "next/server";
import { listBuildsForSite } from "@/lib/hostinger/build-service";
import { parseBuildListSearchParams } from "@/lib/hostinger/build-input";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess("node.builds.list");
    const pagination = parseBuildListSearchParams(request.nextUrl.searchParams);
    const page = await listBuildsForSite(current, pagination);
    return apiSuccess(page);
  } catch (error) {
    return apiFailure(error);
  }
}
