import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDatabaseRequestDiagnostic } from "./database-request-diagnostic";

afterEach(() => {
  vi.restoreAllMocks();
});

function request(overrides: Record<string, unknown> = {}) {
  return reportDatabaseRequestDiagnostic({
    referenceId: "abcdef123456",
    phase: "database_list_filtered",
    upstreamStatus: 422,
    correlationId: "corr-safe",
    endpointKind: "database_list",
    attempt: "filtered",
    result: "retry",
    ...overrides,
  } as never);
}

describe("Hostinger database request diagnostics", () => {
  it("uses info for the expected filtered 422 retry", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    request();

    expect(info).toHaveBeenCalledWith(
      "hostinger_database_request_diagnostic",
      expect.objectContaining({
        phase: "database_list_filtered",
        upstreamStatus: 422,
        attempt: "filtered",
        result: "retry",
      }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("uses info for a successful fallback below 400", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    request({
      phase: "database_list_fallback",
      upstreamStatus: 200,
      attempt: "fallback",
      result: "success",
    });

    expect(info).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("uses error for failures and incoherent result/status combinations", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    request({ phase: "database_list_fallback", attempt: "fallback", result: "failure" });
    request({ phase: "database_list_fallback", attempt: "fallback", result: "success", upstreamStatus: 500 });
    request({ phase: "database_list_fallback", attempt: "fallback", result: "retry", upstreamStatus: 429 });

    expect(error).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalled();
  });

  it("logs only static allowlisted fields and sanitized identifiers", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const referenceId = request({
      referenceId: undefined,
      validationFields: [
        "domain",
        "is_assigned",
        "password",
        "private.example",
        { raw: "must-not-escape" },
      ],
    });

    expect(referenceId).toMatch(/^[a-f0-9]{12}$/);
    expect(consoleInfo).toHaveBeenCalledWith(
      "hostinger_database_request_diagnostic",
      {
        referenceId,
        phase: "database_list_filtered",
        upstreamStatus: 422,
        correlationId: "corr-safe",
        endpointKind: "database_list",
        attempt: "filtered",
        validationFields: ["domain", "is_assigned"],
        result: "retry",
      },
    );
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toMatch(
      /password|private\.example|must-not-escape|raw/i,
    );
  });

  it("drops sensitive correlation IDs and invalid supplied references", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const referenceId = request({
      referenceId: "private reference",
      phase: "remote_list_fallback",
      upstreamStatus: 200,
      correlationId: "corr-authoritative-user",
      endpointKind: "remote_connection_list",
      attempt: "fallback",
      forbiddenValues: ["authoritative-user", "example.com", "u1_shop"],
      result: "success",
    });

    expect(referenceId).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toMatch(
      /private reference|authoritative-user|example\.com|u1_shop/i,
    );
  });

  it("never throws for hostile diagnostic input", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostileInput = new Proxy({}, {
      get() {
        throw new Error("property unavailable");
      },
    });

    expect(() => reportDatabaseRequestDiagnostic(hostileInput as never)).not.toThrow();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      referenceId: "000000000000",
      result: "failure",
    });
  });
});
