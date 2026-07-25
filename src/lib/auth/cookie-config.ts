export const AUTH_COOKIE_PREFIX = "hostinger-console";
export const AUTH_SESSION_COOKIE_NAME = "session_token";

export const AUTH_SESSION_COOKIE_LOOKUP = {
  cookiePrefix: AUTH_COOKIE_PREFIX,
  cookieName: AUTH_SESSION_COOKIE_NAME,
} as const;

export const AUTH_DEFAULT_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;
