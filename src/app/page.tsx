import { redirect } from "next/navigation";
import { getValidatedSession } from "@/lib/auth/session";
import { getApplicationSetupStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!getApplicationSetupStatus().applicationConfigured) {
    redirect("/setup-required");
  }
  const session = await getValidatedSession();
  redirect(session ? "/overview" : "/login");
}
