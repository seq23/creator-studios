// "Today's free AI is used up" (owner, 2 Nov 2026, every studio): the note shows only when both free
// sources are spent for the UTC day (worker/lib/freeAiState.ts), and /api/me carries it to every screen
// (app/components/FreeAiNote.tsx in the Shell, Setup included).
import { describe, expect, it } from "vitest";
import type { Env } from "@worker/env";
import { DAILY_LIMIT_KEY, freeAiUsedUp } from "@worker/lib/freeAiState";
import { meFor } from "@worker/lib/auth";
import { sqliteD1 } from "./helpers/sqlite-d1";

const now = new Date("2026-11-02T18:00:00Z");
const AI = { run: async () => ({}) };
function studio(budget: string, ai: unknown = AI) {
  const d = sqliteD1();
  const env = { DB: d.DB, AI: ai, STUDIO_AI_BUDGET: budget, APP_NAME: "Studio", OWNER_NAME: "", AUTH_MODE: "code", PRACTICE: [] } as unknown as Env;
  const usage = (neurons: number, refused: number, day = "2026-11-02") => d.raw.prepare("INSERT INTO ai_usage (day, neurons, refused) VALUES (?, ?, ?)").run(day, neurons, refused);
  const limited = (until: string) => d.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(DAILY_LIMIT_KEY, JSON.stringify(until));
  return { env, usage, limited };
}

describe("today's free AI is used up", () => {
  it("not used up: a fresh day, share left, no OpenRouter limit", async () => {
    expect(await freeAiUsedUp(studio("1000").env, now)).toBe(false);
  });

  it("used up: the studio's Workers AI share refused a call today (OpenRouter had already not answered)", async () => {
    const s = studio("1000");
    s.usage(980, 1);
    expect(await freeAiUsedUp(s.env, now)).toBe(true);
  });

  it("used up: OpenRouter's free daily limit is reached AND the share is spent, or there is no share", async () => {
    const a = studio("1000");
    a.limited("2026-11-03T00:00:00.000Z");
    a.usage(990, 0);
    expect(await freeAiUsedUp(a.env, now)).toBe(true);
    const b = studio("0");
    b.limited("2026-11-03T00:00:00.000Z");
    expect(await freeAiUsedUp(b.env, now)).toBe(true);
  });

  it("negative proof: OpenRouter limited but the share still has room, or a limit from yesterday, is not used up", async () => {
    const a = studio("1000");
    a.limited("2026-11-03T00:00:00.000Z");
    a.usage(200, 0);
    expect(await freeAiUsedUp(a.env, now)).toBe(false);
    const b = studio("0");
    b.limited("2026-11-02T00:00:00.000Z");
    expect(await freeAiUsedUp(b.env, now)).toBe(false);
  });

  it("/api/me carries it to the app", async () => {
    const s = studio("1000");
    s.usage(1000, 1, new Date().toISOString().slice(0, 10)); // meFor reads the real clock
    const me = await meFor(s.env, { id: "usr_1", email: "o@owner.example", role: "owner" } as never);
    expect(me.freeAiUsedUp).toBe(true);
    expect((await meFor(studio("1000").env, { id: "usr_1", email: "o@owner.example", role: "owner" } as never)).freeAiUsedUp).toBe(false);
  });
});
