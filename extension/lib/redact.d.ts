// Type contract for redact.js, so the Worker's test suite can exercise the real module rather
// than a copy that could drift away from what the extension actually ships.

export type RedactResult =
  | { send: false; reason: string }
  | { send: true; url: string; host: string };

export declare function redactUrl(
  rawUrl: string | null | undefined,
  options?: { fullUrlAllowlist?: string[] },
): RedactResult;
