// Cloudflare Workers AI as the second $0 source (owner, 23 Oct 2026). Past the account's free 10,000
// neurons a day Cloudflare bills, so: each studio spends only its share, checks the worst case first,
// counts every call, and never calls with no share. worker/lib/freeAi.ts.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { budgetOf, freeAi, IMAGE_TOKENS, MAX_OUTPUT_TOKENS, NEURONS_PER_INPUT_TOKEN, NEURONS_PER_OUTPUT_TOKEN, used, utcDay, worstCase } from "../../worker/lib/freeAi";

/** A one-table D1 stand-in for ai_usage. */
function fakeDb() {
  const rows = new Map<string, { neurons: number; calls: number; refused: number }>();
  const stmt = (sql: string) => ({
    bind: (...a: unknown[]) => ({
      first: async () => (sql.startsWith("SELECT") ? (rows.get(a[0] as string) ? { neurons: rows.get(a[0] as string)!.neurons } : null) : null),
      run: async () => {
        const day = (sql.startsWith("UPDATE") ? a[1] : a[0]) as string;
        const r = rows.get(day) ?? { neurons: 0, calls: 0, refused: 0 };
        if (sql.includes("refused")) r.refused += 1;
        else if (sql.startsWith("UPDATE")) r.neurons -= a[0] as number;
        else {
          r.neurons += a[1] as number;
          r.calls += 1;
        }
        rows.set(day, r);
        return {};
      },
    }),
  });
  return { rows, db: { prepare: stmt } };
}
const msgs = [{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(300) }, { type: "image_url" as const, image_url: { url: "data:," } }] }];
const env = (budget: string, ai: unknown, db: unknown) => ({ STUDIO_AI_BUDGET: budget, AI: ai, DB: db }) as never;
const now = new Date("2026-10-24T01:00:00Z");

describe("Cloudflare free AI share", () => {
  it("worst case over-counts: text/3 tokens, a picture as IMAGE_TOKENS, the full output cap", () => {
    expect(worstCase(msgs, 900)).toBeCloseTo((100 + IMAGE_TOKENS) * NEURONS_PER_INPUT_TOKEN + 900 * NEURONS_PER_OUTPUT_TOKEN);
    expect(worstCase(msgs, 99999)).toBeCloseTo((100 + IMAGE_TOKENS) * NEURONS_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * NEURONS_PER_OUTPUT_TOKEN);
    expect(used({ prompt_tokens: 1000, completion_tokens: 100 }, 999)).toBeCloseTo(1000 * NEURONS_PER_INPUT_TOKEN + 100 * NEURONS_PER_OUTPUT_TOKEN);
    expect(used(undefined, 123)).toBe(123);
    expect(utcDay(now)).toBe("2026-10-24");
    expect(budgetOf({ STUDIO_AI_BUDGET: "" })).toBe(0);
  });

  it("calls within the share, counts what was used, and refuses once the share cannot cover a call", async () => {
    const { rows, db } = fakeDb();
    let calls = 0;
    const ai = { run: async () => (calls++, { response: "{\"ok\":1}", usage: { prompt_tokens: 2000, completion_tokens: 200 } }) };
    const one = await freeAi(env("400", ai, db), msgs, 900, now);
    expect(one.ok).toBe(true);
    expect(rows.get("2026-10-24")!.neurons).toBeCloseTo(2000 * NEURONS_PER_INPUT_TOKEN + 200 * NEURONS_PER_OUTPUT_TOKEN);
    let r = one;
    for (let i = 0; i < 10 && r.ok; i++) r = await freeAi(env("400", ai, db), msgs, 900, now);
    expect(r).toMatchObject({ ok: false, why: "budget_out" });
    expect(rows.get("2026-10-24")!.neurons).toBeLessThanOrEqual(400);
    expect(rows.get("2026-10-24")!.refused).toBe(1);
    const before = calls;
    expect((await freeAi(env("400", ai, db), msgs, 900, now)).ok).toBe(false);
    expect(calls).toBe(before); // refused = no call
  });

  it("negative proof: no share, no binding, a failed call keeps its worst case counted", async () => {
    const { rows, db } = fakeDb();
    let calls = 0;
    const ai = { run: async () => (calls++, { response: "x" }) };
    expect(await freeAi(env("0", ai, db), msgs, 900, now)).toMatchObject({ ok: false, why: "no_share" });
    expect(await freeAi(env("500", undefined, db), msgs, 900, now)).toMatchObject({ ok: false, why: "no_share" });
    expect(calls).toBe(0);
    const boom = { run: async () => { throw new Error("down"); } };
    expect(await freeAi(env("500", boom, db), msgs, 900, now)).toMatchObject({ ok: false, why: "failed" });
    expect(rows.get("2026-10-24")!.neurons).toBeCloseTo(worstCase(msgs, 900));
  });

  it("the shares in the registry sum to 8,500 or less of the account's free 10,000, and every studio's env carries its own", () => {
    const root = path.resolve(__dirname, "../..");
    const dir = path.join(root, "studios");
    const shares = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "themes.json").map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
    const total = shares.reduce((n, s) => n + (s.aiBudget ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(8500);
    const cfg = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
    for (const s of shares) expect(cfg).toContain(`"STUDIO_AI_BUDGET": "${s.aiBudget ?? 0}"`);
  });
});
