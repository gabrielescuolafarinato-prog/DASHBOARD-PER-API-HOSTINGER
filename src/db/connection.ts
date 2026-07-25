import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getDatabaseEnv } from "@/lib/env";
import * as dbSchema from "./schema";

let cachedDb: ReturnType<typeof createDatabase> | undefined;

function createDatabase() {
  const client = neon(getDatabaseEnv().DATABASE_URL);
  return drizzle({ client, schema: dbSchema });
}

export function getDb() {
  cachedDb ??= createDatabase();
  return cachedDb;
}

export type Database = ReturnType<typeof getDb>;
