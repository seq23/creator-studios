// OpenRouter's free daily limit is a named state, never a silent fallback (owner, 24 Oct 2026: every
// clip of a re-cut came back waiting for its words once the free route hit its daily limit). The words
// pass tells a daily-limit 429 from a busy one, stops calling OpenRouter until midnight UTC, says so on
// the "Clip words" light (yellow, with when it resets), keeps the clips waiting (no hook, off the
// calendar), and writes them on the first run after the reset.
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { saveConnection } from "@worker/lib/connections";
import { dailyQuotaMessage } from "@worker/services/openrouter";
import { DAILY_LIMIT_KEY, nextUtcMidnight, wordsPass } from "@worker/lib/wordsPass";
import { getSetting } from "@worker/lib/db";

const DAILY = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 } });
const HOOKS = ["Street walk, instant glam", "Boat day outfit, sorted"];
let n = 0;
const good = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ hook: HOOKS[n++ % 2], caption: "Out the door in five.", hashtags: ["#ootd"], voice: "Out the door." }) }, finish_reason: "stop" }] }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("the free daily limit", () => {
  it("tells daily from busy", () => {
    expect(dailyQuotaMessage(DAILY)).toBe(true);
    expect(dailyQuotaMessage(JSON.stringify({ error: { message: "Provider returned error", code: 429 } }))).toBe(false);
    expect(nextUtcMidnight(new Date("2026-10-24T04:30:00Z"))).toBe("2026-10-25T00:00:00.000Z");
  });

  it("is a named state: clips wait, OpenRouter is not called again until it resets, then they get their words", async () => {
    const h = await harness({ FAKE_SERVICES: "0" } as never);
    await saveConnection(h.env, "openrouter", "sk-test", "ok", {});
    await h.dumpWith("dmp_d", [{ id: "ast_d", name: "a.mp4", mime: "video/mp4" }]);
    h.db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status, words_pending)
      VALUES ('clp_dddddddd01', 'ast_d', 'dmp_d', 0, 20, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_d/1.mp4', 'draft', 1),
             ('clp_dddddddd02', 'ast_d', 'dmp_d', 0, 20, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_d/2.mp4', 'draft', 1)`);
    const calls: string[] = [];
    let limited = true;
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      calls.push(String(u));
      return limited ? new Response(DAILY, { status: 429 }) : good();
    }));
    const t0 = new Date("2026-10-24T04:30:00Z");
    const r = await wordsPass(h.env, t0);
    expect(r).toMatchObject({ written: 0, waiting: 2, daily_limit_until: "2026-10-25T00:00:00.000Z" });
    expect(r.misses.daily_limit).toBe(2);
    expect(calls).toHaveLength(1); // after the first daily-limit answer, no more OpenRouter calls this run
    const light = h.one<{ light: string; note: string }>("SELECT light, note FROM health WHERE name = 'Clip words'");
    expect(light.light).toBe("yellow");
    expect(light.note).toMatch(/daily limit is reached\. 2 clips wait for their words, written on the first hourly run after it resets \(00:00 UTC\)/);
    expect(await getSetting(h.env.DB, DAILY_LIMIT_KEY, null)).toBe("2026-10-25T00:00:00.000Z");
    expect(h.all("SELECT id FROM clips WHERE words_pending = 1 AND hook_text = ''")).toHaveLength(2);
    // An hour later, still the same day: OpenRouter is not asked at all.
    await wordsPass(h.env, new Date("2026-10-24T05:30:00Z"));
    expect(calls).toHaveLength(1);
    // After midnight UTC it resets: the words are written and the light is green again.
    limited = false;
    const after = await wordsPass(h.env, new Date("2026-10-25T00:10:00Z"));
    expect(after).toMatchObject({ waiting: 0, daily_limit_until: null });
    expect(after.written).toBe(2);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = 'Clip words'").light).toBe("green");
    expect(await getSetting(h.env.DB, DAILY_LIMIT_KEY, null)).toBeNull();
  });
});
