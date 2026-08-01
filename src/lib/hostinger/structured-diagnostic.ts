import "server-only";

export type StructuredDiagnosticLevel = "info" | "warn" | "error";

export type HostingerStructuredDiagnosticEvent =
  | "hostinger_operation_diagnostic"
  | "hostinger_database_request_diagnostic"
  | "hostinger_build_response_diagnostic"
  | "hostinger_node_restart_diagnostic"
  | "hostinger_site_import_diagnostic";

export function emitStructuredDiagnostic(
  level: StructuredDiagnosticLevel,
  eventName: HostingerStructuredDiagnosticEvent,
  payload: object,
) {
  try {
    if (level === "info") {
      console.info(eventName, payload);
      return;
    }
    if (level === "warn") {
      console.warn(eventName, payload);
      return;
    }
    console.error(eventName, payload);
  } catch {
    // Structured diagnostics must never alter the application response.
  }
}
