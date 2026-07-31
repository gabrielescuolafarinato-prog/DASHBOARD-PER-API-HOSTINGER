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

  it.each([
    ["response_shape", "direct"],
    ["invalid_host_boundary", "data_wrapper"],
  ] as const)(
    "logs static phpMyAdmin category %s without response data",
    (failureKind, responseShape) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      reportHostingerOperationDiagnostic({
        referenceId: "abcdef123456",
        phase: "database_phpmyadmin",
        upstreamStatus: 502,
        operationType: "database.phpmyadmin.link",
        idempotencyStatus: "not_applicable",
        result: "failure",
        failureKind,
        responseShape,
        forbiddenValues: [
          "auth-db123.hostinger.com",
          "https://auth-db123.hostinger.com/signon.php?sid=private",
          "u123_shop",
        ],
      });

      expect(consoleError.mock.calls[0][1]).toEqual({
        referenceId: "abcdef123456",
        phase: "database_phpmyadmin",
        upstreamStatus: 502,
        operationType: "database.phpmyadmin.link",
        idempotencyStatus: "not_applicable",
        result: "failure",
        durationBucket: "<250ms",
        failureKind,
        responseShape,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
        /auth-db|hostinger\.com|signon|sid=|u123_shop/i,
      );
      consoleError.mockRestore();
    },
  );
});
