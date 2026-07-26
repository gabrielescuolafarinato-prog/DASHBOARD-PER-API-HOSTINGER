import type { NextRequest } from "next/server";
import { getBuildLogsForSite } from "@/lib/hostinger/build-service";
import { parseBuildLogSearchParams } from "@/lib/hostinger/build-input";
import { requireNodeApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ uuid: string }> },
) {
  try {
    const current = await requireNodeApiAccess("node.logs.read");
    const { uuid } = await context.params;
    const input = parseBuildLogSearchParams(
      uuid,
      request.nextUrl.searchParams,
    );
    const logs = await getBuildLogsForSite(current, input);
    return apiSuccess(logs);
  } catch (error) {
    return apiFailure(error);
  }
}
