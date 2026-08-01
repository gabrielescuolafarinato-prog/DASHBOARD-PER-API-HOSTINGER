import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseDnsCreateRequest,
  parseDnsDeleteRequest,
  parseDnsUpdateRequest,
} from "@/lib/hostinger/domain-input";
import {
  createDnsRecordForSite,
  deleteDnsRecordForSite,
  updateDnsRecordForSite,
} from "@/lib/hostinger/domain-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("dns.records.create");
    const { input, idempotencyKey } = await parseDnsCreateRequest(request);
    const result = await createDnsRecordForSite(current, input, idempotencyKey);
    revalidatePath("/domains");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("dns.records.update");
    const { input, idempotencyKey } = await parseDnsUpdateRequest(request);
    const result = await updateDnsRecordForSite(current, input, idempotencyKey);
    revalidatePath("/domains");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess("dns.records.delete");
    const { input, idempotencyKey } = await parseDnsDeleteRequest(request);
    const result = await deleteDnsRecordForSite(current, input, idempotencyKey);
    revalidatePath("/domains");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
