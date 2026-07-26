import { describe, expect, it, vi } from "vitest";
import { appendLogChunk, createSingleFlight } from "./log-polling";
import { MAX_LOG_SESSION_BYTES } from "./log-sanitizer";

describe("build log polling controls", () => {
  it("reuses one in-flight request instead of issuing duplicates", async () => {
    let resolve!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((complete) => {
          resolve = complete;
        }),
    );
    const gate = createSingleFlight<string>();
    const first = gate.run(operation);
    const duplicate = gate.run(operation);

    expect(first).toBe(duplicate);
    expect(operation).toHaveBeenCalledOnce();
    expect(gate.active).toBe(true);
    resolve("done");
    await expect(first).resolves.toBe("done");
    expect(gate.active).toBe(false);
  });

  it("caps cumulative output for one browser log session", () => {
    const current = "a".repeat(MAX_LOG_SESSION_BYTES - 20);
    const result = appendLogChunk(current, "b".repeat(100));
    expect(result.limitReached).toBe(true);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      MAX_LOG_SESSION_BYTES,
    );
    expect(result.content).toContain("[SESSION OUTPUT LIMIT REACHED]");
  });
});
