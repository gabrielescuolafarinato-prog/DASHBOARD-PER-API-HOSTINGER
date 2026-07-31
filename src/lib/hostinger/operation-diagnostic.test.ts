import { describe, expect, it, vi } from "vitest";
import { reportHostingerOperationDiagnostic } from "./operation-diagnostic";

describe("Hostinger operation diagnostics", () => {
  it("logs only the fixed safe diagnostic envelope", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    reportHostingerOperationDiagnostic({
      referenceId: "abcdef123456",
      phase: "database_change_password",
      upstreamStatus: 422,
      correlationId: "corr-example.com-u123_shop",
      operationType: "database.password.change",
      idempotencyStatus: "failed",
      result: "failure",
      startedAt: Date.now(),
      forbiddenValues: [
        "example.com",
        "u123_shop",
        "u123_app",
        "192.0.2.10",
        "https://private.example/link",
        "Strong-password-123!",
      ],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "hostinger_operation_diagnostic",
      {
        referenceId: "abcdef123456",
        phase: "database_change_password",
        upstreamStatus: 422,
        operationType: "database.password.change",
        idempotencyStatus: "failed",
        result: "failure",
        durationBucket: "<250ms",
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /example\.com|u123_shop|u123_app|192\.0\.2\.10|Strong-password|https:\/\//i,
    );
    consoleError.mockRestore();
  });
});
