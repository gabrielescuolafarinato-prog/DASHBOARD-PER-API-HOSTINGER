import { describe, expect, it } from "vitest";
import {
  claimDatabaseSubmission,
  claimDatabaseRequest,
  releaseDatabaseRequest,
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

  it("blocks only a duplicate request for the same database", () => {
    const active = new Set<string>();
    expect(claimDatabaseRequest(active, "database-a")).toBe(true);
    expect(claimDatabaseRequest(active, "database-a")).toBe(false);
    expect(claimDatabaseRequest(active, "database-b")).toBe(true);
  });

  it("allows a manual retry after the database request is released", () => {
    const active = new Set<string>();
    claimDatabaseRequest(active, "database-a");
    releaseDatabaseRequest(active, "database-a");
    expect(claimDatabaseRequest(active, "database-a")).toBe(true);
  });
});
