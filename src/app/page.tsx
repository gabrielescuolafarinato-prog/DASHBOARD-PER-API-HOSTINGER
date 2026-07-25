import { notFound, redirect } from "next/navigation";
import { getCurrentDashboardAccess } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const state = await getCurrentDashboardAccess();
  if (state.status === "setup_required") redirect("/setup-required");
  if (
    state.status === "missing_session" ||
    state.status === "inactive_user"
  ) {
    redirect("/login");
  }
  if (state.status === "password_change_required") {
    redirect("/change-password");
  }
  if (state.status === "missing_membership") notFound();
  redirect("/overview");
}
