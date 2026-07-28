import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimRestartSubmission,
  releaseRestartSubmission,
} from "./restart-submission-guard";

describe("Node.js restart UI safety", () => {
  it("allows only one immediate submission for a double click", () => {
    const lock = { current: false };
    expect(claimRestartSubmission(lock)).toBe(true);
    expect(claimRestartSubmission(lock)).toBe(false);
    releaseRestartSubmission(lock);
    expect(claimRestartSubmission(lock)).toBe(true);
  });

  it("renders explicit confirmation, pending and cooldown controls", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/(dashboard)/builds/node-server-operations.tsx",
      ),
      "utf8",
    );
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("Confirm Node.js server restart");
    expect(source).toContain("temporarily unavailable");
    expect(source).toContain("Restart in progress");
    expect(source).toContain("cooldownSeconds > 0");
    expect(source).toContain("claimRestartSubmission");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain('body: "{}"');
    expect(source).not.toMatch(
      /body:\s*\{[^}]*?(?:domain|username|siteId|orderId|token)/s,
    );
  });
});
