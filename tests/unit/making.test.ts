// "Making your posts, ready about 3 PM" on Home (owner, 13 Nov 2026; shared/making.ts,
// worker/routes/home.ts makingNow): an honest guess from this studio's recent runs, "ready soon"
// with no history or once the guess has passed, and nothing at all when nothing is being made.
import { describe, expect, it } from "vitest";
import { makingLine, readyEstimate } from "@shared/making";
import { makingNow } from "@worker/routes/home";
import { harness } from "./helpers/studio-fix-env";

const MIN = 60_000;
const NOW = Date.parse("2026-11-13T19:10:00.000Z");
const TZ = "America/Chicago";

describe("readyEstimate", () => {
  it("adds the middle of the recent runs to when this one started, rounded up to the quarter hour", () => {
    // started 12:50 CT, runs took 40 / 95 / 120 min: 12:50 + 95 = 14:25 → 2:30 PM
    expect(readyEstimate("2026-11-13T18:50:00.000Z", [120 * MIN, 40 * MIN, 95 * MIN], NOW)).toBe("2026-11-13T20:30:00.000Z");
  });
  it("gives no time with no history, with no start, or once the guess has passed", () => {
    expect(readyEstimate("2026-11-13T18:50:00.000Z", [], NOW)).toBeNull();
    expect(readyEstimate(null, [60 * MIN], NOW)).toBeNull();
    expect(readyEstimate("2026-11-13T15:00:00.000Z", [60 * MIN], NOW)).toBeNull();
  });
  it("ignores leftovers that are not a measure (seconds, or days)", () => {
    expect(readyEstimate("2026-11-13T18:50:00.000Z", [5_000, 72 * 3600_000], NOW)).toBeNull();
    expect(readyEstimate("2026-11-13T18:50:00.000Z", [5_000, 72 * 3600_000, 70 * MIN], NOW)).toBe("2026-11-13T20:00:00.000Z");
  });
});

describe("makingLine", () => {
  it("says the time on her clock, the day when it is not today, and 'ready soon' with no time", () => {
    const now = new Date(NOW);
    expect(makingLine("2026-11-13T21:00:00.000Z", now, TZ)).toBe("Making your posts, ready about 3 PM");
    expect(makingLine("2026-11-13T20:30:00.000Z", now, TZ)).toBe("Making your posts, ready about 2:30 PM");
    expect(makingLine("2026-11-14T15:00:00.000Z", now, TZ)).toBe("Making your posts, ready about 9 AM tomorrow");
    expect(makingLine(null, now, TZ)).toBe("Making your posts, ready soon");
  });
});

describe("Home reads it from the studio's own runs", () => {
  it("nothing being made: no line; being made with no history: ready soon; with history: a time", async () => {
    const h = await harness();
    h.db.raw.exec("DELETE FROM dumps");
    expect(await makingNow(h.env.DB, NOW)).toBeNull();
    h.db.raw.exec("INSERT INTO dumps (id, door, status, dumped_at) VALUES ('dmp_now', 'new', 'cutting', '2026-11-13T18:50:00.000Z')");
    expect(await makingNow(h.env.DB, NOW)).toEqual({ readyAt: null });
    h.db.raw.exec(`INSERT INTO dumps (id, door, status, dumped_at, ready_at) VALUES
      ('dmp_a', 'new', 'ready', '2026-11-10T10:00:00.000Z', '2026-11-10T11:35:00.000Z'),
      ('dmp_b', 'new', 'reviewed', '2026-11-11T10:00:00.000Z', '2026-11-11T10:40:00.000Z'),
      ('dmp_c', 'new', 'ready', '2026-11-12T10:00:00.000Z', '2026-11-12T12:00:00.000Z')`);
    expect(await makingNow(h.env.DB, NOW)).toEqual({ readyAt: "2026-11-13T20:30:00.000Z" });
    // A run that finishes leaves nothing being made: the line goes away.
    h.db.raw.exec("UPDATE dumps SET status = 'ready', ready_at = '2026-11-13T19:05:00.000Z' WHERE id = 'dmp_now'");
    expect(await makingNow(h.env.DB, NOW)).toBeNull();
  });
});
