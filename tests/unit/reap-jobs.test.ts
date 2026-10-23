// A job whose runner died before calling back is failed by the hourly reaper and handled like any
// failure (23 Oct 2026: a cut runner's setup step failed, the dump stayed "cutting" forever and Start
// over refused). A job still in its window is left alone; a late report after the reap is ignored.
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { NEVER_STARTED_MIN, RAN_TOO_LONG_MIN, reapStuckJobs } from "@worker/crons/reapJobs";
import { readFileSync } from "node:fs";

let env: Env;
let db: ReturnType<typeof sqliteD1>;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(() => {
  db = sqliteD1();
  env = { DB: db.DB, FILES: memoryR2().FILES, FAKE_SERVICES: "1", APP_NAME: "S", PUBLIC_BASE_URL: "http://w.example", GITHUB_REPO: "x/y", OWNER_EMAIL: "o@example.com" } as unknown as Env;
  db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_s', 'new', '', 'cutting'), ('dmp_ok', 'new', '', 'cutting');
    INSERT INTO jobs (id, type, status, ref_id, nonce, created_at) VALUES ('job_dead', 'cut', 'dispatched', 'dmp_s', 'n', '${ago(NEVER_STARTED_MIN + 5)}'),
      ('job_fresh', 'cut', 'dispatched', 'dmp_ok', 'n', '${ago(5)}');
    INSERT INTO jobs (id, type, status, ref_id, nonce, created_at, started_at) VALUES ('job_long', 'cut', 'running', 'dmp_ok', 'n', '${ago(RAN_TOO_LONG_MIN + 30)}', '${ago(RAN_TOO_LONG_MIN + 20)}'),
      ('job_working', 'cut', 'running', 'dmp_ok', 'n', '${ago(60)}', '${ago(55)}');`);
});

describe("stuck jobs are reaped", () => {
  it("fails a never-started job and a too-long one, frees the dump, leaves fresh ones", async () => {
    expect(await reapStuckJobs(env)).toBe(2);
    const st = (id: string) => (db.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
    expect([st("job_dead"), st("job_long"), st("job_fresh"), st("job_working")]).toEqual(["failed", "failed", "dispatched", "running"]);
    expect((db.raw.prepare("SELECT status FROM dumps WHERE id = 'dmp_s'").get() as { status: string }).status).toBe("failed");
    expect(await reapStuckJobs(env)).toBe(0);
  });
  it("runs every hour, and a job's own late failure report is not handled twice", () => {
    expect(readFileSync("worker/crons/index.ts", "utf8")).toMatch(/await bufferSync\(env\);\n\s*const reaped = await reapStuckJobs\(env\);/);
    expect(readFileSync("worker/routes/jobs.ts", "utf8")).toContain('if (job.status === "failed") return c.json({ ok: true, already: true });');
    // The window is longer than the longest job workflow's timeout.
    const longest = Math.max(...["job-cut", "job-voice", "job-photopack", "job-fullvideo"].map((f) => Math.max(...[...readFileSync(`.github/workflows/${f}.yml`, "utf8").matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1])))));
    expect(RAN_TOO_LONG_MIN).toBeGreaterThan(longest);
  });
});
