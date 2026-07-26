import { MAX_LOG_SESSION_BYTES } from "./log-sanitizer";

export function createSingleFlight<T>() {
  let pending: Promise<T> | undefined;
  return {
    run(operation: () => Promise<T>) {
      pending ??= operation().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    get active() {
      return pending !== undefined;
    },
  };
}

export function appendLogChunk(current: string, chunk: string) {
  const encoder = new TextEncoder();
  const combined = `${current}${chunk}`;
  const combinedBytes = encoder.encode(combined);
  if (combinedBytes.byteLength <= MAX_LOG_SESSION_BYTES) {
    return { content: combined, limitReached: false };
  }
  if (encoder.encode(current).byteLength >= MAX_LOG_SESSION_BYTES) {
    return { content: current, limitReached: true };
  }

  const suffix = "\n[SESSION OUTPUT LIMIT REACHED]";
  const suffixBytes = encoder.encode(suffix).byteLength;
  const available = MAX_LOG_SESSION_BYTES - suffixBytes;
  let safeContent = new TextDecoder("utf-8", { fatal: false }).decode(
    combinedBytes.slice(0, MAX_LOG_SESSION_BYTES - suffixBytes),
  );
  while (encoder.encode(safeContent).byteLength > available) {
    safeContent = safeContent.slice(0, -1);
  }
  return {
    content: `${safeContent}${suffix}`,
    limitReached: true,
  };
}
