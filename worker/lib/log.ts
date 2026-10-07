// Public-repo logging rule (BUILD_PLAN.md section 13): logs carry step names, counts and
// pass/fail only. Never a transcript, caption, brand text, file name, link or id that
// could identify her content. Every log line in the Worker goes through here so the
// rule is enforced in one place; tests/validators/no-content-in-logs.mjs greps for
// direct console.* calls outside this file.

type Level = "info" | "warn" | "error";

const FORBIDDEN_KEYS = new Set(["caption", "hook", "hook_text", "notes", "transcript", "file_name", "email", "url", "r2_key", "body", "subject", "secret", "token", "key"]);

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string") out[k] = v.length > 64 ? `[${v.length} chars]` : v;
    else out[k] = "[object]";
  }
  return out;
}

function emit(level: Level, step: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, step, ...scrub(fields) });
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (step: string, fields?: Record<string, unknown>) => emit("info", step, fields),
  warn: (step: string, fields?: Record<string, unknown>) => emit("warn", step, fields),
  error: (step: string, fields?: Record<string, unknown>) => emit("error", step, fields),
};

/** Turn any thrown value into a short, content-free summary for the jobs table and the UI. */
export function safeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message.slice(0, 120)}`;
  return "unknown error";
}
