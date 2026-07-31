import { describe, expect, it, vi } from "vitest";
import { reportDatabaseRequestDiagnostic } from "./database-request-diagnostic";

describe("Hostinger database request diagnostics", () => {
  it("logs only static allowlisted fields and sanitized identifiers", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const referenceId = reportDatabaseRequestDiagnostic({
      phase: "database_list_filtered",
      upstreamStatus: 422,
      correlationId: "corr-safe",
      endpointKind: "database_list",
      attempt: "filtered",
      validationFields: [
        "domain",
        "is_assigned",
        "password",
        "private.example",
        { raw: "must-not-escape" },
      ],
      result: "retry",
    });

    expect(referenceId).toMatch(/^[a-f0-9]{12}$/);
    expect(consoleError).toHaveBeenCalledWith(
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
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /password|private\.example|must-not-escape|raw/i,
    );
    consoleError.mockRestore();
  });

  it("drops sensitive correlation IDs and invalid supplied references", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const referenceId = reportDatabaseRequestDiagnostic({
      referenceId: "private reference",
      phase: "remote_list_fallback",
      upstreamStatus: 200,
      correlationId: "corr-authoritative-user",
      endpointKind: "remote_connection_list",
      attempt: "fallback",
      forbiddenValues: [
        "authoritative-user",
        "example.com",
        "u1_shop",
      ],
      result: "success",
    });

    expect(referenceId).toMatch(/^[a-f0-9]{12}$/);
    const serialized = JSON.stringify(consoleError.mock.calls);
    expect(serialized).not.toMatch(
      /private reference|authoritative-user|example\.com|u1_shop/i,
    );
    consoleError.mockRestore();
  });
});
