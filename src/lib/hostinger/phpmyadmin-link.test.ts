import { describe, expect, it } from "vitest";
import {
  decodePhpMyAdminLink,
  PhpMyAdminLinkError,
  validatePhpMyAdminLink,
} from "./phpmyadmin-link";

const directLink =
  "https://auth-db123.hostinger.com/signon.php?sid=sanitized";
const wrappedLink =
  "https://auth-db456.hostinger.com/signon.php?sid=sanitized";

describe("phpMyAdmin response decoder", () => {
  it("accepts the official direct resource and ignores extra fields", () => {
    expect(
      decodePhpMyAdminLink({
        link: directLink,
        extra: "ignored",
      }),
    ).toEqual({ link: directLink, responseShape: "direct" });
  });

  it("accepts only the bounded data wrapper compatibility shape", () => {
    expect(
      decodePhpMyAdminLink({
        data: { link: wrappedLink, extra: "ignored" },
        extra: "ignored",
      }),
    ).toEqual({
      link: wrappedLink,
      responseShape: "data_wrapper",
    });
  });

  it("accepts matching direct and wrapped values without ambiguity", () => {
    expect(
      decodePhpMyAdminLink({
        link: directLink,
        data: { link: directLink },
      }),
    ).toEqual({ link: directLink, responseShape: "direct" });
  });

  it("rejects different direct and wrapped links as ambiguous", () => {
    expectFailure(
      () =>
        decodePhpMyAdminLink({
          link: directLink,
          data: { link: wrappedLink },
        }),
      "ambiguous_link",
    );
  });

  it.each([
    {},
    { data: {} },
    null,
  ])("rejects payload without a link", (payload) => {
    expectFailure(
      () => decodePhpMyAdminLink(payload),
      "missing_link",
    );
  });

  it.each([
    { link: 123 },
    { link: null },
    { link: [directLink] },
    { data: { link: 123 } },
  ])("rejects a non-string link", (payload) => {
    expectFailure(
      () => decodePhpMyAdminLink(payload),
      "response_shape",
    );
  });

  it("rejects an array payload without searching recursively", () => {
    expectFailure(
      () => decodePhpMyAdminLink([{ link: directLink }]),
      "response_shape",
    );
  });

  it("rejects nested wrapper variants outside the allowlist", () => {
    expectFailure(
      () =>
        decodePhpMyAdminLink({
          data: { result: { link: directLink } },
        }),
      "missing_link",
    );
  });
});

describe("phpMyAdmin temporary URL validation", () => {
  it.each([
    directLink,
    "https://auth-db-eu-01.hostinger.com/signon.php?sid=sanitized",
    "https://database-access.hostinger.com/signon.php?sid=sanitized",
    "https://nested.database-access.hostinger.com/signon.php?sid=sanitized",
    "https://auth-db123.hostinger.com:443/signon.php?sid=sanitized",
  ])("accepts an HTTPS Hostinger subdomain: %s", (value) => {
    expect(validatePhpMyAdminLink(value)).toBe(
      new URL(value).toString(),
    );
  });

  it.each([
    "https://auth-db123.hostinger.com/signon.php?sid=abc123",
    "https://auth-db123.hostinger.com/signon.php?user=value",
    "https://auth-db123.hostinger.com/signon.php?username=value",
    "https://auth-db123.hostinger.com/signon.php?password=value",
    "https://auth-db123.hostinger.com/signon.php?user=a&password=b&signature=c",
  ])("treats the Hostinger query as opaque: %s", (value) => {
    expect(validatePhpMyAdminLink(value)).toBe(
      new URL(value).toString(),
    );
  });

  it.each([
    [
      "https://hostinger.com.evil.example/signon",
      "invalid_host_boundary",
    ],
    [
      "https://evilhostinger.com/signon",
      "invalid_host_boundary",
    ],
    ["https://hostinger.com/signon", "invalid_host_boundary"],
    [
      "http://auth-db123.hostinger.com/signon",
      "invalid_protocol",
    ],
    [
      "https://user@auth-db123.hostinger.com/signon",
      "credentials_present",
    ],
    [
      "https://user:secret@auth-db123.hostinger.com/signon",
      "credentials_present",
    ],
    [
      "https://auth-db123.hostinger.com:8443/signon",
      "invalid_port",
    ],
    [
      "https://auth-db123.hostinger.com/signon#temporary",
      "fragment_present",
    ],
    ["/signon.php?sid=abc123", "malformed_url"],
    ["not a url", "malformed_url"],
    [
      "https://auth-db123.hostinger.com/signon\n",
      "malformed_url",
    ],
  ] as const)(
    "rejects unsafe URL %s as %s",
    (value, failureKind) => {
      expectFailure(
        () => validatePhpMyAdminLink(value),
        failureKind,
      );
    },
  );

  it("rejects an overlong URL before parsing it", () => {
    expectFailure(
      () =>
        validatePhpMyAdminLink(
          `https://auth-db123.hostinger.com/signon.php?sid=${"a".repeat(4_096)}`,
        ),
      "malformed_url",
    );
  });
});

function expectFailure(
  action: () => unknown,
  failureKind: PhpMyAdminLinkError["failureKind"],
) {
  try {
    action();
    throw new Error("Expected phpMyAdmin validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(PhpMyAdminLinkError);
    expect(error).toMatchObject({ failureKind, status: 502 });
    expect(JSON.stringify(error)).not.toMatch(
      /auth-db|hostinger\.com|sid=|sanitized/i,
    );
  }
}
