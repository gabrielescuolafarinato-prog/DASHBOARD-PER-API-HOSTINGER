import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { schema, user } from "@/db/schema";
import { getAuthEnv } from "@/lib/env";
import {
  authAccessControl,
  collaboratorAuthRole,
  ownerAuthRole,
} from "@/lib/auth/permissions";

function createAuth() {
  const env = getAuthEnv();

  return betterAuth({
    appName: "Hostinger Site Console",
    baseURL: {
      allowedHosts: env.AUTH_ALLOWED_HOSTS,
      protocol: env.AUTH_BASE_URL_PROTOCOL,
    },
    secret: env.AUTH_SECRET,
    trustedOrigins: env.AUTH_ALLOWED_ORIGINS,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
    }),
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "hostinger-console",
      useSecureCookies: env.IS_PRODUCTION,
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        isActive: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (candidate) => {
            const [record] = await getDb()
              .select({ isActive: user.isActive })
              .from(user)
              .where(eq(user.id, candidate.userId))
              .limit(1);
            if (!record?.isActive) {
              throw new APIError("FORBIDDEN", {
                message: "This account is disabled.",
              });
            }
            return { data: candidate };
          },
        },
      },
    },
    plugins: [
      admin({
        defaultRole: "COLLABORATOR",
        ac: authAccessControl,
        roles: {
          OWNER: ownerAuthRole,
          COLLABORATOR: collaboratorAuthRole,
        },
        bannedUserMessage: "This account is disabled.",
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth["$Infer"]["Session"];

let authInstance: Auth | undefined;

export function getAuth(): Auth {
  authInstance ??= createAuth();
  return authInstance;
}
