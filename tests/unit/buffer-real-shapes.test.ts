// The real Buffer client's request shapes, pinned to what Buffer's live API demanded in the
// Phase 0 live test (26 Sep 2026): Instagram needs metadata.instagram.type, YouTube needs a title
// and a category, and a post's `error` is an object whose fields must be selected (a bare
// `error` made Buffer refuse the whole read, so no post was ever marked posted).
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuffer, postMetadata, YOUTUBE_CATEGORY_ID } from "@worker/services/buffer";
import type { Env } from "@worker/env";

const env = { FAKE_SERVICES: "0" } as unknown as Env;
function stub(answer: unknown) {
  const sent: { query: string; variables: Record<string, any> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: answer }), { status: 200 });
    }),
  );
  return sent;
}
afterEach(() => vi.unstubAllGlobals());
const args = (platform: "tiktok" | "instagram" | "youtube", title = "Three candles, five minutes") => ({ channelId: "ch", platform, title, text: "TEST", mediaUrl: "https://e.test/media/t", scheduledAt: "2026-09-26T02:10:00.000Z" });

describe("createPost sends what each platform requires", () => {
  it("Instagram: a reel shared to the feed", async () => {
    const sent = stub({ createPost: { post: { id: "p1" } } });
    const b = await getBuffer(env, "k");
    expect(await b.createPost(args("instagram"))).toEqual({ ok: true, id: "p1", error: null });
    expect(sent[0]!.variables.input.metadata).toEqual({ instagram: { type: "reel", shouldShareToFeed: true } });
  });
  it("YouTube: the hook as title (≤100 chars) and a category", async () => {
    const sent = stub({ createPost: { post: { id: "p2" } } });
    const b = await getBuffer(env, "k");
    await b.createPost(args("youtube", `  ${"x".repeat(150)} `));
    const yt = sent[0]!.variables.input.metadata.youtube;
    expect(yt).toMatchObject({ categoryId: YOUTUBE_CATEGORY_ID, privacy: "public", madeForKids: false });
    expect(yt.title).toHaveLength(100);
    expect(postMetadata("youtube", "   ")).toMatchObject({ youtube: { title: "New video" } });
  });
  it("a clip with her cloned voice: isAiGenerated goes to Buffer on all three (schema-checked 26 Sep 2026)", async () => {
    const sent = stub({ createPost: { post: { id: "p4" } } });
    const b = await getBuffer(env, "k");
    for (const p of ["tiktok", "instagram", "youtube"] as const) await b.createPost({ ...args(p), aiGenerated: true });
    expect(sent.map((x) => x.variables.input.metadata)).toEqual([
      { tiktok: { isAiGenerated: true } },
      { instagram: { type: "reel", shouldShareToFeed: true, isAiGenerated: true } },
      { youtube: expect.objectContaining({ title: "Three candles, five minutes", categoryId: YOUTUBE_CATEGORY_ID, isAiGenerated: true }) },
    ]);
  });
  it("TikTok: no metadata", async () => {
    const sent = stub({ createPost: { post: { id: "p3" } } });
    await (await getBuffer(env, "k")).createPost(args("tiktok"));
    expect(sent[0]!.variables.input.metadata).toBeUndefined();
  });
});

describe("getPost reads the error object and the link", () => {
  it("selects error's fields and returns its message", async () => {
    const sent = stub({ post: { id: "p", status: "error", error: { message: "The video is too long for Reels.", supportUrl: null }, externalLink: null } });
    const st = await (await getBuffer(env, "k")).getPost("p");
    expect(sent[0]!.query).toMatch(/error\s*\{\s*message/);
    expect(st).toEqual({ id: "p", status: "failed", url: null, error: "The video is too long for Reels." });
  });
  it("sent → posted with the external link", async () => {
    stub({ post: { id: "p", status: "sent", error: null, externalLink: "https://www.tiktok.com/@x/video/1" } });
    expect(await (await getBuffer(env, "k")).getPost("p")).toEqual({ id: "p", status: "posted", url: "https://www.tiktok.com/@x/video/1", error: null });
  });
});
