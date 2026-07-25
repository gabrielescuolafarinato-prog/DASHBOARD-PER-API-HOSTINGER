import { domainToASCII } from "node:url";
import { AppError } from "@/lib/errors";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_HOSTNAME_SYNTAX = /[/:?#@\\*]/;
const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Returns one canonical ASCII hostname suitable for exact comparisons.
 *
 * Only surrounding whitespace and a DNS root dot are normalized. URL syntax,
 * credentials, ports, paths, wildcards and malformed IDNs are rejected rather
 * than repaired into a different target.
 */
export function normalizeDomain(input: string) {
  if (typeof input !== "string" || CONTROL_CHARACTERS.test(input)) {
    throw invalidDomain();
  }

  const trimmed = input.trim();
  if (
    !trimmed ||
    /\s/.test(trimmed) ||
    FORBIDDEN_HOSTNAME_SYNTAX.test(trimmed)
  ) {
    throw invalidDomain();
  }

  const withoutRootDot = trimmed.endsWith(".")
    ? trimmed.slice(0, -1)
    : trimmed;
  if (!withoutRootDot || withoutRootDot.endsWith(".")) {
    throw invalidDomain();
  }

  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii !== ascii.normalize("NFC")) {
    throw invalidDomain();
  }

  const labels = ascii.split(".");
  if (labels.some((label) => !ASCII_LABEL.test(label))) {
    throw invalidDomain();
  }

  return ascii;
}

function invalidDomain() {
  return new AppError(
    "VALIDATION_ERROR",
    "The configured Hostinger domain must be a hostname without URL syntax, credentials, port, path, wildcard, or control characters.",
    400,
  );
}
