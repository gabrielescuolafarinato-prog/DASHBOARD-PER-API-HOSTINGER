import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";
import { getApplicationSetupStatus } from "@/lib/env";

const setupRequiredResponse = () =>
  Response.json(
    {
      error: {
        code: "SETUP_REQUIRED",
        message: "Server configuration is required.",
      },
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    },
  );

async function handleAuth(request: Request, method: "GET" | "POST") {
  if (!getApplicationSetupStatus().applicationConfigured) {
    return setupRequiredResponse();
  }

  const handlers = toNextJsHandler(getAuth());
  return handlers[method](request);
}

export function GET(request: Request) {
  return handleAuth(request, "GET");
}

export function POST(request: Request) {
  return handleAuth(request, "POST");
}
