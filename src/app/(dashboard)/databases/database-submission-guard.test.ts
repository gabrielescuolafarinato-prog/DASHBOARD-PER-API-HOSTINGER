import { describe, expect, it } from "vitest";
import {
  claimDatabaseSubmission,
  releaseDatabaseSubmission,
} from "./database-submission-guard";

describe("database submission guard", () => {
  it("allows only one call while the first submission is pending", () => {
    const lock = { current: false };
    expect(claimDatabaseSubmission(lock)).toBe(true);
    expect(claimDatabaseSubmission(lock)).toBe(false);
    expect(lock.current).toBe(true);
  });

  it("allows a later submission only after explicit release", () => {
    const lock = { current: false };
    claimDatabaseSubmission(lock);
    releaseDatabaseSubmission(lock);
    expect(claimDatabaseSubmission(lock)).toBe(true);
  });
});
