import { describe, expect, it } from "vitest";
import {
  decodePhpMyAdminLink,
  parsePhpMyAdminAllowedHostSuffixes,
  phpMyAdminDiagnosticCode,
  PhpMyAdminLinkError,
  validateAuthenticatedPhpMyAdminLink,
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
    "https://phpmyadmin-login.infrastructure-provider.net/signon.php?sid=sanitized",
    "https://auth-db123.hostinger.com:443/signon.php?sid=sanitized",
  ])("accepts a public HTTPS destination from Hostinger: %s", (value) => {
    expect(validateAuthenticatedPhpMyAdminLink(value)).toBe(
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
    expect(validateAuthenticatedPhpMyAdminLink(value)).toBe(
      new URL(value).toString(),
    );
  });

  it.each([
    ["https://localhost/signon", "local_hostname"],
    ["https://db.localhost/signon", "local_hostname"],
    ["https://intranet/signon", "invalid_public_hostname"],
    ["https://127.0.0.1/signon", "ip_literal"],
    ["https://[::1]/signon", "ip_literal"],
    ["https://db.local/signon", "blocked_suffix"],
    ["https://db.internal/signon", "blocked_suffix"],
    ["https://db.test/signon", "blocked_suffix"],
    ["https://db.invalid/signon", "blocked_suffix"],
    ["https://db.example/signon", "blocked_suffix"],
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
    ["//auth-db123.hostinger.com/signon", "malformed_url"],
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
        () => validateAuthenticatedPhpMyAdminLink(value),
        failureKind,
      );
    },
  );

  it("rejects DNS labels longer than 63 characters", () => {
    expectFailure(
      () =>
        validateAuthenticatedPhpMyAdminLink(
          `https://${"a".repeat(64)}.net/signon`,
        ),
      "invalid_dns_syntax",
    );
  });

  it("rejects hostnames longer than 253 characters", () => {
    const hostname = `${"a".repeat(50)}.${"b".repeat(50)}.${"c".repeat(50)}.${"d".repeat(50)}.${"e".repeat(50)}.net`;
    expectFailure(
      () =>
        validateAuthenticatedPhpMyAdminLink(
          `https://${hostname}/signon`,
        ),
      "invalid_dns_syntax",
    );
  });

  it("rejects invalid DNS label characters", () => {
    expectFailure(
      () =>
        validateAuthenticatedPhpMyAdminLink(
          "https://auth_db.public.net/signon",
        ),
      "invalid_dns_syntax",
    );
  });

  it("rejects an overlong URL before parsing it", () => {
    expectFailure(
      () =>
        validateAuthenticatedPhpMyAdminLink(
          `https://auth-db123.hostinger.com/signon.php?sid=${"a".repeat(4_096)}`,
        ),
      "malformed_url",
    );
  });

  it("accepts a public host when optional pinning is absent", () => {
    expect(
      validateAuthenticatedPhpMyAdminLink(
        "https://secure-login.public-provider.net/signon",
      ),
    ).toBe("https://secure-login.public-provider.net/signon");
  });

  it("accepts an exact configured suffix with a DNS-label boundary", () => {
    expect(
      validateAuthenticatedPhpMyAdminLink(
        "https://secure-login.public-provider.net/signon",
        { allowedHostSuffixes: ["public-provider.net"] },
      ),
    ).toBe("https://secure-login.public-provider.net/signon");
  });

  it("rejects a public host outside configured suffixes", () => {
    expectFailure(
      () =>
        validateAuthenticatedPhpMyAdminLink(
          "https://secure-login.other-provider.net/signon",
          { allowedHostSuffixes: ["public-provider.net"] },
        ),
      "configured_host_not_allowed",
    );
  });
});

describe("phpMyAdmin optional host pinning configuration", () => {
  it("normalizes, deduplicates and preserves explicit suffixes", () => {
    expect(
      parsePhpMyAdminAllowedHostSuffixes(
        "public-provider.net, secure.public-provider.net,public-provider.net",
      ),
    ).toEqual([
      "public-provider.net",
      "secure.public-provider.net",
    ]);
  });

  it.each([
    "HTTPS://public-provider.net",
    "*.public-provider.net",
    "public-provider.net:443",
    "public-provider.net/path",
    "PUBLIC-PROVIDER.NET",
    "localhost",
    "db.local",
    "127.0.0.1",
    "public-provider.net,",
    "public-provider..net",
  ])("fails closed for malformed configured suffix %s", (value) => {
    expect(() =>
      parsePhpMyAdminAllowedHostSuffixes(value),
    ).toThrow("Invalid phpMyAdmin host suffix configuration.");
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
    expect(error).toMatchObject({
      failureKind,
      status: 502,
      diagnosticCode: phpMyAdminDiagnosticCode(failureKind),
    });
    expect(JSON.stringify(error)).not.toMatch(
      /auth-db|hostinger\.com|sid=|sanitized/i,
    );
  }
}
