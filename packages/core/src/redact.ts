/**
 * Journal redaction: the journal must never contain secrets, tokens, or
 * credential values. We store shapes, hashes, lengths, and paths instead.
 *
 * Two layers:
 *  - a global denylist of key names that always redact, so a future real
 *    connector is safe even if its manifest forgets to opt fields out;
 *  - per-tool `redactFields` from the capability manifest for anything
 *    connector-specific (e.g. a real email body that could carry secrets).
 */
import { createHash } from "node:crypto";

const GLOBAL_DENYLIST = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "cookie",
  "session",
  "private_key",
  "privatekey",
  "ssn",
];

function isDenied(key: string, extraFields: readonly string[]): boolean {
  const k = key.toLowerCase();
  return (
    GLOBAL_DENYLIST.some((d) => k === d || k.includes(d)) ||
    extraFields.some((f) => f.toLowerCase() === k)
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      __redacted: true,
      sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
      length: value.length,
    };
  }
  return { __redacted: true, type: typeof value };
}

export function redactArgs(
  args: unknown,
  extraFields: readonly string[] = [],
): unknown {
  if (args === null || args === undefined) return args;
  if (Array.isArray(args)) return args.map((v) => redactArgs(v, extraFields));
  if (typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      out[key] = isDenied(key, extraFields)
        ? redactValue(value)
        : redactArgs(value, extraFields);
    }
    return out;
  }
  return args;
}
