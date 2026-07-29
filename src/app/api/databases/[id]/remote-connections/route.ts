import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { requireHostingerApiAccess } from "@/lib/hostinger/api-access";
import { apiFailure, apiSuccess } from "@/lib/hostinger/api-response";
import {
  parseDatabaseId,
  parseRemoteConnectionRequest,
} from "@/lib/hostinger/database-input";
import {
  addRemoteConnectionForSite,
  removeRemoteConnectionForSite,
} from "@/lib/hostinger/database-service";
import { assertTrustedMutationRequest } from "@/lib/security/request-origin";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return await mutate(request, context, "add");
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return await mutate(request, context, "remove");
}

async function mutate(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  action: "add" | "remove",
) {
  try {
    assertTrustedMutationRequest(request);
    const current = await requireHostingerApiAccess(
      "database.remote.connections",
    );
    const databaseId = parseDatabaseId((await context.params).id);
    const { input, idempotencyKey } =
      await parseRemoteConnectionRequest(request);
    const result =
      action === "add"
        ? await addRemoteConnectionForSite(
            current,
            databaseId,
            input,
            idempotencyKey,
          )
        : await removeRemoteConnectionForSite(
            current,
            databaseId,
            input,
            idempotencyKey,
          );
    revalidatePath("/databases");
    return apiSuccess(result);
  } catch (error) {
    return apiFailure(error);
  }
}
