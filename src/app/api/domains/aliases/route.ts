import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseAliasCreateRequest,
  parseAliasDeleteRequest,
  parseEmptyDomainSearchParams,
} from "@/lib/hostinger/domain-input";
import {
  createAliasForSite,
  deleteAliasForSite,
  listAliasesForSite,
} from "@/lib/hostinger/domain-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const current = await requireHostingerApiAccess("aliases.list");
    parseEmptyDomainSearchParams(request.nextUrl.searchParams);
    return apiSuccess(await listAliasesForSite(current));
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("aliases.create");
    const { input, idempotencyKey } = await parseAliasCreateRequest(request);
    const result = await createAliasForSite(current, input, idempotencyKey);
    revalidatePath("/domains");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("aliases.delete");
    const { input, idempotencyKey } = await parseAliasDeleteRequest(request);
    const result = await deleteAliasForSite(current, input, idempotencyKey);
    revalidatePath("/domains");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
