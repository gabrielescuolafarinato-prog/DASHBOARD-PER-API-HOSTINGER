import "server-only";
import { getAuthEnv, isAllowedAuthOrigin } from "@/lib/env";
import { AppError } from "@/lib/errors";

export function assertTrustedMutationRequest(
  request: Request,
  allowedOrigins = getAuthEnv().AUTH_ALLOWED_ORIGINS,
) {
  const candidate = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  let candidateOrigin: string | undefined;
  try {
    const parsed = candidate ? new URL(candidate) : undefined;
    candidateOrigin =
      parsed &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
        ? parsed.origin
        : undefined;
  } catch {
    candidateOrigin = undefined;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !candidateOrigin ||
    candidateOrigin !== requestOrigin ||
    !isAllowedAuthOrigin(candidateOrigin, allowedOrigins) ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    throw new AppError(
      "FORBIDDEN",
      "The request origin is not allowed.",
      403,
    );
  }
}
