import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

/** Log in through the real one-time-code flow; fake services return the code in the response. */
export async function login(page: Page, email = "owner@studio.example") {
  const res = await page.request.post("/api/auth/request", { data: { email } });
  const { dev_code } = (await res.json()) as { dev_code?: string };
  if (!dev_code) throw new Error("fake services did not return a login code");
  const v = await page.request.post("/api/auth/verify", { data: { email, code: dev_code } });
  if (!v.ok()) throw new Error(`verify failed: ${v.status()}`);
}

/** The local D1 was busy with the Worker's own write (nothing wrong with the SQL): worth another try. */
export function isBusy(e: unknown): boolean {
  const said = `${String((e as { stderr?: unknown }).stderr ?? "")}\n${String((e as { stdout?: unknown }).stdout ?? "")}\n${String(e)}`;
  return /internal error|database is locked|SQLITE_BUSY/.test(said);
}

/**
 * Run SQL against the local D1 that `wrangler dev` serves the suite from. Specs use it to seed
 * what another phase's screen would have produced, and to put back what they changed: every spec
 * leaves the database as it found it, because the next spec's assertions start from the base
 * state (no approved brief → launch posting slots; no locked profile → the Dump gate is closed).
 */
export function sql<T = Record<string, unknown>>(command: string): T[] {
  // Playwright runs from the repo root, where wrangler dev keeps its local D1.
  // This is a second process on the SQLite file the running Worker writes to. While the Worker holds
  // a write (a page's follow-on work, a cron lane) the local D1 answers "internal error" or
  // "database is locked: SQLITE_BUSY" and nothing of the command is applied: try again, then fail
  // loudly. Any other error (bad SQL, a missing table) fails at once.
  let out = "";
  for (let attempt = 1; ; attempt++) {
    try {
      out = execFileSync("npx", ["wrangler", "d1", "execute", "creator-studios-dev-db", "--local", "--json", "--command", command], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      break;
    } catch (e) {
      if (attempt >= 4 || !isBusy(e)) throw e;
      execFileSync("sleep", [String(attempt)]);
    }
  }
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed[parsed.length - 1]?.results ?? [];
}
