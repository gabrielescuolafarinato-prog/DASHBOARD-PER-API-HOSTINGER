import { authorizeCurrentSurface } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await authorizeCurrentSurface("root");
  return null;
}
