import { afterEach, describe, expect, it, vi } from "vitest";
import { emitStructuredDiagnostic } from "./structured-diagnostic";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured Hostinger diagnostic emitter", () => {
  it.each(["info", "warn", "error"] as const)(
    "does not propagate console.%s exceptions",
    (level) => {
      const logger = vi.spyOn(console, level).mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      const payload = { referenceId: "abcdef123456", result: "success" };

      expect(() =>
        emitStructuredDiagnostic(
          level,
          "hostinger_operation_diagnostic",
          payload,
        ),
      ).not.toThrow();
      expect(logger).toHaveBeenCalledOnce();
      expect(logger).toHaveBeenCalledWith(
        "hostinger_operation_diagnostic",
        payload,
      );
    },
  );
});
