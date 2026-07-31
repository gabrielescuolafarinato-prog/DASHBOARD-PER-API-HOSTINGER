import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseVulnerabilityListSearchParams,
  parseVulnerabilityPatchRequest,
} from "@/lib/hostinger/vulnerability-input";
import {
  listVulnerabilitiesForSite,
  patchVulnerabilitiesForSite,
} from "@/lib/hostinger/vulnerability-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess(
      "site.vulnerabilities.list",
    );
    const severities = parseVulnerabilityListSearchParams(
      request.nextUrl.searchParams,
    );
    return apiSuccess(
      await listVulnerabilitiesForSite(current, severities),
    );
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess(
      "site.vulnerabilities.patch",
    );
    const { input, idempotencyKey } =
      await parseVulnerabilityPatchRequest(request);
    const result = await patchVulnerabilitiesForSite(
      current,
      input.vulnerabilityIds,
      idempotencyKey,
    );
    revalidatePath("/vulnerabilities");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
