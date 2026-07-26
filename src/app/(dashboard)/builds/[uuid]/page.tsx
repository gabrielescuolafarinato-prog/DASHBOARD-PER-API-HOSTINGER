import { notFound } from "next/navigation";
import { z } from "zod";
import { requireDashboardSession } from "@/lib/auth/session";
import { BuildLogs } from "./build-logs";

export const metadata = { title: "Build logs" };
export const dynamic = "force-dynamic";

export default async function BuildLogsPage({
  params,
}: {
  params: Promise<{ uuid: string }>;
}) {
  await requireDashboardSession();
  const parsed = z.string().uuid().safeParse((await params).uuid);
  if (!parsed.success) notFound();
  return <BuildLogs uuid={parsed.data} />;
}
