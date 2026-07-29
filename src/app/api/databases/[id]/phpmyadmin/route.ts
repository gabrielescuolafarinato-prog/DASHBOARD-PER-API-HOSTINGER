import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseDatabaseId,
  parseEmptyDatabaseSearchParams,
} from "@/lib/hostinger/database-input";
import { getPhpMyAdminLinkForSite } from "@/lib/hostinger/database-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const current = await requireHostingerApiAccess(
      "database.phpmyadmin.link",
    );
    parseEmptyDatabaseSearchParams(request.nextUrl.searchParams);
    const databaseId = parseDatabaseId((await context.params).id);
    return apiSuccess(
      await getPhpMyAdminLinkForSite(current, databaseId),
    );
  } catch (error) {
    return apiFailure(error);
  }
}
