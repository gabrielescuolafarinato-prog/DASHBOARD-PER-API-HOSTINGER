export const MAX_LOG_RESPONSE_BYTES = 128 * 1024;
export const MAX_LOG_SESSION_BYTES = 512 * 1024;

const ansiPattern = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:",
    "(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007)",
    "|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join(""),
  "g",
);

const connectionStringPattern =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'<>]+/gi;
const bearerPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const sensitiveAssignmentPattern =
  /(\b(?:[A-Za-z][A-Za-z0-9_.-]*?)?(?:password|passwd|pwd|token|secret(?:[_-]?key)?|api[_-]?key|client[_-]?secret)\b\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const commandPasswordPattern =
  /(\s--?(?:password|passwd|pwd)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi;

export type SanitizedBuildLogs = {
  content: string;
  bytes: number;
  truncated: boolean;
};

export function sanitizeBuildLogs(input: string): SanitizedBuildLogs {
  const redacted = input
    .replace(ansiPattern, "")
    .replace(connectionStringPattern, "[REDACTED_CONNECTION_STRING]")
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(sensitiveAssignmentPattern, "$1[REDACTED]")
    .replace(commandPasswordPattern, "$1[REDACTED]");

  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= MAX_LOG_RESPONSE_BYTES) {
    return {
      content: redacted,
      bytes: encoded.byteLength,
      truncated: false,
    };
  }

  const suffix = "\n[OUTPUT TRUNCATED]";
  const encoder = new TextEncoder();
  const suffixBytes = encoder.encode(suffix);
  const available = MAX_LOG_RESPONSE_BYTES - suffixBytes.byteLength;
  let prefix = new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.slice(0, available),
  );
  while (encoder.encode(prefix).byteLength > available) {
    prefix = prefix.slice(0, -1);
  }
  const content = prefix + suffix;
  return {
    content,
    bytes: encoder.encode(content).byteLength,
    truncated: true,
  };
}
