import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimImportSubmission,
  releaseImportSubmission,
} from "./import-submission-guard";

describe("Hostinger import submission guard", () => {
  it("allows only one operation for a double submit and resets after a result", () => {
    const lock = { current: false };

    expect(claimImportSubmission(lock)).toBe(true);
    expect(claimImportSubmission(lock)).toBe(false);

    releaseImportSubmission(lock);
    expect(claimImportSubmission(lock)).toBe(true);
  });

  it("keeps server redirect as the only navigation and renders referenced errors", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/onboarding/hostinger-onboarding.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("disabled={pending}");
    expect(source).toContain("claimImportSubmission");
    expect(source).toContain("importState.message");
    expect(source).not.toContain("router.push");
    expect(source).not.toContain("router.replace");
    expect(source).not.toContain("The operation could not be completed");
  });
});
