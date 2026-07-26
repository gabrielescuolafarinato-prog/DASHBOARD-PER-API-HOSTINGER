import { describe, expect, it } from "vitest";
import {
  MAX_LOG_RESPONSE_BYTES,
  sanitizeBuildLogs,
} from "./log-sanitizer";

describe("build log sanitization", () => {
  it("removes ANSI control sequences", () => {
    expect(
      sanitizeBuildLogs(
        "\u001b[31mfailed\u001b[0m\n\u001b[1;32msuccess\u001b[0m",
      ).content,
    ).toBe("failed\nsuccess");
  });

  it("redacts bearer tokens, passwords, secrets and connection strings", () => {
    const source = [
      "Authorization: Bearer abc.DEF-123_secret",
      "password=hunter2",
      "DB_PASSWORD=database-password",
      "HOSTINGER_API_TOKEN=hostinger-token",
      'client_secret: "never-show-this"',
      "DATABASE_URL=postgresql://user:password@db.invalid/app",
      "redis://default:redis-secret@cache.invalid:6379/0",
      "command --password cli-secret",
    ].join("\n");
    const sanitized = sanitizeBuildLogs(source).content;

    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("password=[REDACTED]");
    expect(sanitized).toContain("client_secret: [REDACTED]");
    expect(sanitized).toContain("[REDACTED_CONNECTION_STRING]");
    expect(sanitized).toContain("--password [REDACTED]");
    expect(sanitized).not.toMatch(
      /abc\.DEF|hunter2|never-show|user:password|redis-secret|cli-secret/,
    );
    expect(sanitized).not.toMatch(/database-password|hostinger-token/);
  });

  it("limits each sanitized response by UTF-8 byte length", () => {
    const result = sanitizeBuildLogs("€".repeat(MAX_LOG_RESPONSE_BYTES));
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES);
    expect(result.content).toContain("[OUTPUT TRUNCATED]");
  });
});
