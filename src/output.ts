// Shared output + error layer. (PLAN.md → Conventions, Exit-code taxonomy.)
// Discipline: results → stdout, diagnostics → stderr. JSON is the default;
// --text is the human opt-out.

export const EXIT = {
  OK: 0,
  USAGE: 2, // bad command/flag usage
  NOT_FOUND: 3, // session/log/tool not found
  INVALID_VALUE: 4, // bad enum value
  EMPTY: 5, // no match / empty result
  IO: 6, // index / filesystem error
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// A structured CLI error that maps to an exit code and a JSON error shape.
export class CliError extends Error {
  code: ExitCode;
  payload: Record<string, unknown>;
  constructor(code: ExitCode, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : "error");
    this.code = code;
    this.payload = payload;
  }
}

// Helpers that produce the canonical error shapes. Every error aims to be
// self-healing (Principle 3): name the valid set AND a working invocation so the
// caller can correct in one retry.
export function errInvalidValue(flag: string, got: string, valid: string[], usage?: string): CliError {
  return new CliError(EXIT.INVALID_VALUE, { error: "invalid_value", flag, got, valid, ...(usage ? { usage } : {}) });
}
export function errNotFound(kind: string, id: string, hint: string, usage?: string): CliError {
  return new CliError(EXIT.NOT_FOUND, { error: "not_found", kind, id, hint, ...(usage ? { usage } : {}) });
}
export function errUsage(message: string, usage?: string, hint?: string): CliError {
  return new CliError(EXIT.USAGE, { error: "usage", message, ...(usage ? { usage } : {}), ...(hint ? { hint } : {}) });
}
export function errEmpty(message: string, hint?: string): CliError {
  return new CliError(EXIT.EMPTY, { error: "empty", message, ...(hint ? { hint } : {}) });
}

export interface OutputMode {
  json: boolean; // true = JSON (default), false = --text
}

// Emit a successful result to stdout in the chosen format. `textRender` builds
// the human string lazily (only called in --text mode).
export function emit(data: unknown, mode: OutputMode, textRender?: (d: any) => string): void {
  if (mode.json || !textRender) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(textRender(data) + "\n");
  }
}

// Emit an error to stderr in the chosen format and return its exit code.
export function emitError(err: unknown, mode: OutputMode): ExitCode {
  if (err instanceof CliError) {
    if (mode.json) {
      process.stderr.write(JSON.stringify(err.payload) + "\n");
    } else {
      const p = err.payload;
      let line = `error: ${p.error}`;
      if (p.message) line += `: ${p.message}`;
      if (p.flag) line += ` (${p.flag}=${JSON.stringify(p.got)})`;
      if (p.kind && p.id) line += `: ${p.kind} ${JSON.stringify(p.id)}`;
      if (Array.isArray(p.valid)) line += `\n  valid: ${p.valid.join(", ")}`;
      if (p.usage) line += `\n  usage: ${p.usage}`;
      if (p.hint) line += `\n  ${p.hint}`;
      process.stderr.write(line + "\n");
    }
    return err.code;
  }
  // Unexpected error → IO/internal.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    mode.json ? JSON.stringify({ error: "internal", message: msg }) + "\n" : `error: internal: ${msg}\n`,
  );
  return EXIT.IO;
}
