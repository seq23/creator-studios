import { beforeEach, describe, expect, it } from "vitest";
import {
  bufferDueAt,
  capRefusal,
  channelHealth,
  choosePostsToLoad,
  connectionFlips,
  createFailureDecision,
  dueForReadBack,
  fillWeek,
  localDate,
  moveToDate,
  pickSlotTable,
  queueUsed,
  readBackDecision,
  shouldCheckBuffer,
  type ExistingPost,
} from "@worker/domain/sync";
import { planWeek, weekBounds, zonedToUtc, type SchedulableClip } from "@worker/domain/slotting";
import { FakeBuffer, platformOf, resetFakeBuffer } from "@worker/services/buffer";
import { BUFFER_MAX_RETRIES, BUFFER_QUEUE_LIMIT_PER_CHANNEL, DEFAULT_WEEKLY_CAPS, HARD_CAP_PER_CHANNEL_PER_WEEK, LAUNCH_SLOTS, PLATFORMS } from "@shared/constants";

const TZ = "America/New_York";
const WEEK = weekBounds(new Date("2026-09-30T12:00:00Z"), TZ); // Mon 28 Sep → Mon 5 Oct
const BEFORE = "2026-09-26T12:00:00.000Z"; // the Saturday before: every slot is in the future

function clip(i: number, extra: Partial<SchedulableClip> = {}): SchedulableClip {
  return { id: `c${i}`, asset_id: `a${i}`, score: 1 - i / 100, platforms: ["tiktok", "instagram", "youtube"], door: i % 2 ? "recycle" : "new", ...extra };
}
const clips = (n: number) => Array.from({ length: n }, (_, i) => clip(i));

function fill(cs: SchedulableClip[], existing: ExistingPost[] = [], now = BEFORE, caps = DEFAULT_WEEKLY_CAPS) {
  return fillWeek({ clips: cs, existing, weekStart: WEEK.start, weekEnd: WEEK.end, timeZone: TZ, caps, slots: LAUNCH_SLOTS, now });
}
const asExisting = (ps: { clip_id: string; platform: ExistingPost["platform"]; scheduled_at: string }[], status: ExistingPost["status"] = "planned"): ExistingPost[] => ps.map((p, i) => ({ id: `p${i}`, status, ...p }));
const count = (ps: { platform: string }[], p: string) => ps.filter((x) => x.platform === p).length;

describe("fillWeek (plan ahead)", () => {
  it("an empty week at launch caps gets 22 posts from 10 unique clips: 10 / 7 / 5", () => {
    const out = fill(clips(12));
    expect(out).toHaveLength(22);
    expect([count(out, "tiktok"), count(out, "instagram"), count(out, "youtube")]).toEqual([10, 7, 5]);
    expect(new Set(out.map((p) => p.clip_id)).size).toBe(10);
  });

  it("matches planWeek exactly for an empty week", () => {
    const cs = clips(12);
    expect(fill(cs)).toEqual(planWeek(cs, WEEK.start, TZ, DEFAULT_WEEKLY_CAPS));
  });

  it("is idempotent: running it again on its own output adds nothing", () => {
    const cs = clips(12);
    const first = fill(cs);
    expect(fill(cs, asExisting(first))).toEqual([]);
  });

  it("never exceeds the cap, even when settings ask for more than 10", () => {
    const out = fill(clips(30), [], BEFORE, { tiktok: 40, instagram: 40, youtube: 40 });
    for (const p of PLATFORMS) expect(count(out, p)).toBeLessThanOrEqual(HARD_CAP_PER_CHANNEL_PER_WEEK);
  });

  it("fills only the room left after posts she placed by hand", () => {
    const manual = asExisting([
      { clip_id: "x1", platform: "tiktok", scheduled_at: "2026-09-29T15:00:00.000Z" },
      { clip_id: "x2", platform: "tiktok", scheduled_at: "2026-09-29T16:00:00.000Z" },
    ]);
    const out = fill(clips(12), manual);
    expect(count(out, "tiktok")).toBe(8);
  });

  it("never puts a clip on a platform twice, in any week", () => {
    const earlier = asExisting([{ clip_id: "c0", platform: "tiktok", scheduled_at: "2026-09-22T19:00:00.000Z" }], "posted");
    const out = fill(clips(12), earlier);
    expect(out.find((p) => p.clip_id === "c0" && p.platform === "tiktok")).toBeUndefined();
  });

  it("keeps a clip's posts inside one week (10 unique clips a week): a clip used last week is not reused", () => {
    const earlier = asExisting([{ clip_id: "c0", platform: "tiktok", scheduled_at: "2026-09-22T19:00:00.000Z" }]);
    const out = fill(clips(12), earlier);
    expect(out.some((p) => p.clip_id === "c0")).toBe(false);
  });

  it("an unscheduled post frees the slot and does not count toward the cap", () => {
    const first = fill(clips(12));
    const tiktok = first.filter((p) => p.platform === "tiktok");
    const existing = asExisting(first);
    const idx = existing.findIndex((p) => p.clip_id === tiktok[0].clip_id && p.platform === "tiktok");
    existing[idx] = { ...existing[idx], status: "unscheduled" };
    const again = fill(clips(12), existing);
    expect(count(again, "tiktok")).toBe(1);
  });

  it("skips clips with a platform unticked", () => {
    const cs = clips(12).map((c) => ({ ...c, platforms: c.id === "c0" ? (["tiktok"] as const).slice() : c.platforms }));
    const out = fill(cs as SchedulableClip[]);
    expect(out.filter((p) => p.clip_id === "c0").map((p) => p.platform)).toEqual(["tiktok"]);
  });

  it("never plans a slot in the past (a week already under way only fills what is left)", () => {
    const now = "2026-10-01T12:00:00.000Z"; // Thursday 8 am New York
    const out = fill(clips(12), [], now);
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) expect(p.scheduled_at > now).toBe(true);
    expect(count(out, "tiktok")).toBeLessThan(10);
  });

  it("with no approved clips it plans nothing", () => {
    expect(fill([])).toEqual([]);
  });
});

describe("pickSlotTable", () => {
  it("uses the launch baseline when there is no approved brief", () => {
    expect(pickSlotTable(undefined)).toEqual({ slots: LAUNCH_SLOTS, source: "launch" });
  });
  it("uses the brief's best times when every platform has at least one valid slot", () => {
    const bt = { tiktok: [{ day: 2, hour: 18, minute: 0, claim: {} }], instagram: [{ day: 3, hour: 19, minute: 30 }], youtube: [{ day: 5, hour: 16, minute: 0 }, { day: 5, hour: 16, minute: 0 }] };
    const r = pickSlotTable(bt);
    expect(r.source).toBe("brief");
    expect(r.slots.tiktok).toEqual([{ day: 2, hour: 18, minute: 0 }]);
    expect(r.slots.youtube).toHaveLength(1); // duplicates removed
  });
  it("falls back to launch when any platform has no slot, or a slot is nonsense", () => {
    expect(pickSlotTable({ tiktok: [{ day: 2, hour: 18, minute: 0 }], instagram: [], youtube: [{ day: 1, hour: 1, minute: 0 }] }).source).toBe("launch");
    expect(pickSlotTable({ tiktok: [{ day: 9, hour: 18 }], instagram: [{ day: 1, hour: 25 }], youtube: [{ day: 1, hour: 1 }] }).source).toBe("launch");
  });
});

describe("capRefusal", () => {
  it("allows up to the cap and refuses past it, in plain words", () => {
    expect(capRefusal("TikTok", 9, 10)).toBeNull();
    expect(capRefusal("TikTok", 10, 10)).toMatch(/TikTok already has 10 posts that week and your limit is 10/);
    expect(capRefusal("Instagram", 7, 7)).toMatch(/limit is 7/);
  });
  it("the hard cap of 10 wins over a bigger setting", () => {
    expect(capRefusal("TikTok", 10, 50)).not.toBeNull();
  });
});

describe("moveToDate", () => {
  it("keeps the local time of day when moving to another day, across a DST change", () => {
    const at = zonedToUtc(2026, 10, 30, 15, 0, TZ); // Fri 3 pm EDT
    const moved = moveToDate(at, "2026-11-02", TZ, zonedToUtc)!; // Mon 3 pm EST
    expect(moved).toBe("2026-11-02T20:00:00.000Z");
    expect(localDate(moved, TZ)).toBe("2026-11-02");
  });
  it("refuses a malformed date", () => {
    expect(moveToDate("2026-10-01T19:00:00.000Z", "next tuesday", TZ, zonedToUtc)).toBeNull();
  });
});

describe("choosePostsToLoad (what goes to Buffer this hour)", () => {
  const now = "2026-09-28T12:00:00.000Z";
  const at = (days: number) => new Date(Date.parse(now) + days * 86400_000).toISOString();
  const ready = { tiktok: true, instagram: true, youtube: true };

  it("loads only posts inside the next 7 days, earliest first", () => {
    const r = choosePostsToLoad(
      [
        { id: "late", platform: "tiktok", scheduled_at: at(8) },
        { id: "b", platform: "tiktok", scheduled_at: at(2) },
        { id: "a", platform: "tiktok", scheduled_at: at(1) },
      ],
      {},
      ready,
      now,
    );
    expect(r.load.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("never lets a channel pass 10 queued posts", () => {
    const planned = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, platform: "tiktok" as const, scheduled_at: at(1 + i / 10) }));
    const r = choosePostsToLoad(planned, { tiktok: BUFFER_QUEUE_LIMIT_PER_CHANNEL - 4 }, ready, now);
    expect(r.load).toHaveLength(4);
    expect(r.waitingNoRoom).toBe(2);
  });

  it("holds posts for a disconnected channel safely and still loads the others", () => {
    const r = choosePostsToLoad(
      [
        { id: "ig", platform: "instagram", scheduled_at: at(1) },
        { id: "tt", platform: "tiktok", scheduled_at: at(1) },
      ],
      {},
      { tiktok: true, instagram: false, youtube: true },
      now,
    );
    expect(r.load.map((p) => p.id)).toEqual(["tt"]);
    expect(r.waitingDisconnected).toBe(1);
  });

  it("a post whose time already passed while Buffer was down is loaded, due a few minutes from now", () => {
    const r = choosePostsToLoad([{ id: "old", platform: "youtube", scheduled_at: at(-1) }], {}, ready, now);
    expect(r.load.map((p) => p.id)).toEqual(["old"]);
    expect(bufferDueAt(at(-1), now)).toBe("2026-09-28T12:10:00.000Z");
    expect(bufferDueAt(at(2), now)).toBe(at(2));
  });
});

describe("request budget", () => {
  const now = "2026-09-28T12:00:00.000Z";
  it("checks the key at most every 6 hours while all is well", () => {
    expect(shouldCheckBuffer(null, now, false)).toBe(true);
    expect(shouldCheckBuffer("2026-09-28T09:00:00.000Z", now, false)).toBe(false);
    expect(shouldCheckBuffer("2026-09-28T06:00:00.000Z", now, false)).toBe(true);
  });
  it("checks every hour while something is broken, and whenever she presses Check", () => {
    expect(shouldCheckBuffer("2026-09-28T11:30:00.000Z", now, true)).toBe(true);
    expect(shouldCheckBuffer("2026-09-28T11:30:00.000Z", now, false, true)).toBe(true);
  });
  it("counts queue slots as the higher of our own queued posts and Buffer's count", () => {
    expect(queueUsed({ tiktok: 3 }, { tiktok: 5, instagram: 1 })).toEqual({ tiktok: 5, instagram: 1, youtube: 0 });
  });
  it("reads back only posts whose time has come", () => {
    const due = dueForReadBack([{ scheduled_at: "2026-09-28T11:00:00.000Z" }, { scheduled_at: "2026-09-28T13:00:00.000Z" }], now);
    expect(due).toHaveLength(1);
  });
});

describe("read back and retries", () => {
  it("queued or unreadable stays in Buffer; sent becomes posted with its link", () => {
    expect(readBackDecision("queued", null, 0, false)).toEqual({ next: "in_buffer" });
    expect(readBackDecision("unknown", null, 0, false)).toEqual({ next: "in_buffer" });
    expect(readBackDecision("posted", "https://x", 0, false)).toEqual({ next: "posted", url: "https://x" });
  });
  it(`retries a failure ${BUFFER_MAX_RETRIES} times, then fails and emails once`, () => {
    expect(readBackDecision("failed", null, 0, false)).toEqual({ next: "retry", retries: 1 });
    expect(readBackDecision("failed", null, BUFFER_MAX_RETRIES - 1, false)).toEqual({ next: "retry", retries: BUFFER_MAX_RETRIES });
    expect(readBackDecision("failed", null, BUFFER_MAX_RETRIES, false)).toEqual({ next: "failed", email: true });
    expect(readBackDecision("failed", null, BUFFER_MAX_RETRIES, true)).toEqual({ next: "failed", email: false });
  });
  it("a post Buffer refuses at create follows the same budget", () => {
    expect(createFailureDecision(0, false)).toEqual({ status: "planned", retries: 1, email: false });
    expect(createFailureDecision(BUFFER_MAX_RETRIES, false)).toEqual({ status: "failed", retries: BUFFER_MAX_RETRIES, email: true });
    expect(createFailureDecision(BUFFER_MAX_RETRIES, true).email).toBe(false);
  });
});

describe("Connection needs you: once per flip", () => {
  it("emails when a connection goes from ok to broken", () => {
    expect(connectionFlips({ Buffer: "ok", meta: "ok" }, { Buffer: "bad", meta: "ok" })).toEqual(["Buffer"]);
  });
  it("does not email again while it stays broken, nor when she disconnects it herself, nor for a first sighting", () => {
    expect(connectionFlips({ Buffer: "bad" }, { Buffer: "bad" })).toEqual([]);
    expect(connectionFlips({ google: "ok" }, { google: "off" })).toEqual([]);
    expect(connectionFlips({}, { Buffer: "bad" })).toEqual([]);
  });
  it("emails again after it was fixed and broke a second time", () => {
    const runs: Record<string, "ok" | "bad">[] = [{ B: "ok" }, { B: "bad" }, { B: "ok" }, { B: "bad" }];
    const sent = runs.slice(1).flatMap((r, i) => connectionFlips(runs[i], r));
    expect(sent).toEqual(["B", "B"]);
  });
});

describe("channel health lights", () => {
  it("not added in Buffer yet is yellow with the add-channels guide, not an error", () => {
    expect(channelHealth("TikTok", null, 0, null)).toMatchObject({ light: "yellow", fix: "add-channels-in-buffer", state: "off" });
  });
  it("disconnected is red with the reconnect guide; a failed post is red with the post-failed guide", () => {
    expect(channelHealth("TikTok", { connected: false, handle: "@s" }, 0, null)).toMatchObject({ light: "red", fix: "reconnect-an-account", state: "bad" });
    expect(channelHealth("TikTok", { connected: true, handle: "@s" }, 2, null)).toMatchObject({ light: "red", fix: "a-post-failed", note: "2 posts did not go out" });
  });
  it("connected with nothing wrong is green", () => {
    expect(channelHealth("TikTok", { connected: true, handle: "@s" }, 0, null)).toMatchObject({ light: "green", fix: null, state: "ok" });
  });
});

describe("fake Buffer (the stand-in the sync runs against)", () => {
  beforeEach(() => resetFakeBuffer());
  const input = (mediaUrl: string) => ({ channelId: "ch_tiktok", platform: "tiktok" as const, title: "hook", text: "t", mediaUrl, scheduledAt: "2026-09-29T19:00:00.000Z" });

  it("created posts fill the queue, then read back as posted and leave it", async () => {
    const b = new FakeBuffer("good-key-0000");
    const a = await b.createPost(input("https://x/media/abc"));
    await b.createPost(input("https://x/media/def"));
    expect(await b.queueCount("ch_tiktok")).toBe(2);
    const st = await b.getPost(a.id!);
    expect(st.status).toBe("posted");
    expect(st.url).toMatch(/^https:\/\//);
    expect(await b.queueCount("ch_tiktok")).toBe(1);
  });
  it("a fail media link is accepted, then fails on every read", async () => {
    const b = new FakeBuffer("good-key-0000");
    const r = await b.createPost(input("https://x/media/failxyz"));
    expect(r.ok).toBe(true);
    expect((await b.getPost(r.id!)).status).toBe("failed");
    expect((await b.getPost(r.id!)).status).toBe("failed");
  });
  it("a reject media link is refused at create; no key refuses everything", async () => {
    expect((await new FakeBuffer("good-key-0000").createPost(input("https://x/media/reject"))).ok).toBe(false);
    expect((await new FakeBuffer(null).createPost(input("https://x/media/abc"))).ok).toBe(false);
  });
  it("deleted posts leave the queue", async () => {
    const b = new FakeBuffer("good-key-0000");
    const r = await b.createPost(input("https://x/media/abc"));
    await b.deletePost(r.id!);
    expect(await b.queueCount("ch_tiktok")).toBe(0);
  });
  it("key shapes: bad / expired refused, ig-missing disconnects Instagram, no-channels finds none", async () => {
    expect((await new FakeBuffer("bad-key").checkKey()).ok).toBe(false);
    expect((await new FakeBuffer("expired-key").checkKey()).ok).toBe(false);
    const ig = await new FakeBuffer("good-key-ig-missing").checkKey();
    expect(ig.channels.find((c) => c.platform === "instagram")?.connected).toBe(false);
    const none = await new FakeBuffer("good-key-no-channels").checkKey();
    expect(none).toMatchObject({ ok: true, channels: [] });
  });
});

describe("Buffer service enum mapping", () => {
  it("matches the Service enum case-insensitively", () => {
    expect(platformOf("TIKTOK")).toBe("tiktok");
    expect(platformOf("instagram")).toBe("instagram");
    expect(platformOf("youtube")).toBe("youtube");
    expect(platformOf("twitter")).toBeNull();
  });
});
