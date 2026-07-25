import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection";
import { account, user } from "../src/db/schema";
import { assertStrongPassword } from "../src/lib/auth/password-policy";

function readArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const email = (process.env.BOOTSTRAP_OWNER_EMAIL ?? readArg("email"))
    ?.trim()
    .toLowerCase();
  const name = (process.env.BOOTSTRAP_OWNER_NAME ?? readArg("name"))?.trim();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD ?? readArg("password");
  if (!email || !name || !password) {
    throw new Error(
      "Provide BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_NAME and BOOTSTRAP_OWNER_PASSWORD (or --email=, --name=, --password=).",
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("The owner email is invalid.");
  }
  assertStrongPassword(password);
  const db = getDb();
  const [duplicate] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (duplicate) throw new Error("An account with this email already exists.");

  const userId = crypto.randomUUID();
  await db.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    role: "OWNER",
    isActive: true,
    mustChangePassword: false,
  });
  try {
    await db.insert(account).values({
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    });
  } catch (error) {
    await db.delete(user).where(eq(user.id, userId));
    throw error;
  }
  console.info(
    `OWNER created for ${email}. Password was not logged. Site onboarding is still required.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Bootstrap failed.");
  process.exitCode = 1;
});
