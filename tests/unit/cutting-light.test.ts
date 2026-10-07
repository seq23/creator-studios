// One light for clip cutting (Phase 0 live test, 25 Sep 2026): the cut job wrote a "Cutting"
// row while the hourly check wrote "Clip cutting", so Settings showed two lights for one thing
// and they could disagree. Both now go through clipCuttingLight on the real schema.
import { beforeEach, describe, expect, it } from "vitest";
import { cutJob } from "@worker/jobs/cut";
import { CLIP_CUTTING, serviceHealthRows } from "@worker/crons/buffer-sync";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";

let env: Env;
let raw: ReturnType<typeof sqliteD1>["raw"];
const cuttingRows = () => raw.prepare("SELECT name, light, note FROM health WHERE name LIKE '%utting%' ORDER BY name").all() as { name: string; light: string; note: string }[];

beforeEach(() => {
  const d = sqliteD1();
  raw = d.raw;
  env = { DB: d.DB, FAKE_SERVICES: "0", RESEND_API_KEY: "re_test", GITHUB_DISPATCH_TOKEN: "x", OWNER_EMAIL: "owner@example.com", PUBLIC_BASE_URL: "https://e.test" } as unknown as Env;
  raw.prepare("INSERT INTO dumps (id, door, status) VALUES ('d1', 'new', 'cutting')").run();
  raw.prepare("INSERT INTO jobs (id, type, status, ref_id, nonce) VALUES ('j1', 'cut', 'running', 'd1', 'n')").run();
});

describe("clip cutting light", () => {
  it("a failed cut turns the ONE cutting light red at once, before the job row is marked", async () => {
    await cutJob.onFailure(env, "j1", "d1", "ffmpeg exited 1");
    expect(cuttingRows()).toEqual([expect.objectContaining({ name: CLIP_CUTTING, light: "red" })]);
    expect(cuttingRows()[0]!.note).not.toMatch(/cutting now/); // the job that just failed is not "still cutting"
  });

  it("the hourly check retires a legacy 'Cutting' row and agrees with the jobs table", async () => {
    raw.prepare("INSERT INTO health (name, light, note) VALUES ('Cutting', 'green', 'Last cut 2026-09-25: 4 clips')").run();
    raw.prepare("UPDATE jobs SET status = 'done', finished_at = '2026-09-25T10:00:00.000Z' WHERE id = 'j1'").run();
    await serviceHealthRows(env);
    expect(cuttingRows()).toEqual([{ name: CLIP_CUTTING, light: "green", note: "Last job OK · 2026-09-25" }]);
  });
});
