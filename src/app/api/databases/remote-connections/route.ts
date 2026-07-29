import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import { parseEmptyDatabaseSearchParams } from "@/lib/hostinger/database-input";
import { listRemoteConnectionsForSite } from "@/lib/hostinger/database-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess(
      "database.remote.connections",
    );
    parseEmptyDatabaseSearchParams(request.nextUrl.searchParams);
    return apiSuccess(await listRemoteConnectionsForSite(current));
  } catch (error) {
    return apiFailure(error);
  }
}
