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
    ["local_hostname", "data_wrapper"],
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
        payloadStructure:
          failureKind === "response_shape"
            ? {
                payloadKind: "object",
                hasDirectLink: true,
                hasData: false,
                dataKind: "other",
                hasWrappedLink: false,
                responseShape: "direct",
              }
            : undefined,
        forbiddenValues: [
          "auth-db123.hostinger.com",
          "https://auth-db123.hostinger.com/signon.php?sid=private",
          "localhost",
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
        ...(failureKind === "response_shape"
          ? {
              payloadKind: "object",
              hasDirectLink: true,
              hasData: false,
              dataKind: "other",
              hasWrappedLink: false,
            }
          : {}),
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
        /auth-db|hostinger\.com|localhost|signon|sid=|u123_shop/i,
      );
      consoleError.mockRestore();
    },
  );

  it("never propagates a reporter exception", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        throw new Error("logger unavailable");
      });

    expect(() =>
      reportHostingerOperationDiagnostic({
        referenceId: "abcdef123456",
        phase: "database_phpmyadmin",
        upstreamStatus: 502,
        operationType: "database.phpmyadmin.link",
        idempotencyStatus: "not_applicable",
        result: "failure",
        failureKind: "response_shape",
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("drops unsafe correlation data when sanitization itself fails", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const forbiddenValues = new Proxy([] as unknown[], {
      get() {
        throw new Error("sanitizer input unavailable");
      },
    });

    expect(() =>
      reportHostingerOperationDiagnostic({
        referenceId: "abcdef123456",
        phase: "database_phpmyadmin",
        upstreamStatus: 502,
        correlationId: "must-not-escape",
        operationType: "database.phpmyadmin.link",
        idempotencyStatus: "not_applicable",
        result: "failure",
        forbiddenValues,
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      "hostinger_operation_diagnostic",
      expect.not.objectContaining({ correlationId: expect.anything() }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "must-not-escape",
    );
    consoleError.mockRestore();
  });

  it("does not throw when diagnostic object construction encounters hostile input", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const hostileInput = new Proxy(
      {},
      {
        get() {
          throw new Error("property unavailable");
        },
      },
    );

    expect(() =>
      reportHostingerOperationDiagnostic(hostileInput as never),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      referenceId: "000000000000",
      phase: "database_phpmyadmin",
      result: "failure",
    });
    consoleError.mockRestore();
  });
});
