// Buffer posting (section 10). Buffer's public API is GraphQL at https://api.buffer.com
// with a personal key (free plan: 3,000 requests per 30 days, so callers budget). The
// client is behind one interface so the fake and the real one are interchangeable and
// the rest of the dashboard never learns which is in play.
import type { Env } from "../env";
import { fakeServices } from "../env";
import type { Platform } from "@shared/constants";
import { getConnectionSecret } from "../lib/connections";
import { log } from "../lib/log";

export interface BufferChannel {
  id: string;
  platform: Platform;
  handle: string;
  connected: boolean;
  /** Queue paused inside Buffer: nothing publishes until she presses Resume there. */
  paused?: boolean;
  /** The platform's own id for the account (YouTube: the UC… channel id), from Buffer's `serviceId`. */
  service_id?: string | null;
  /** The account's public link (Buffer's `externalLink`). */
  link?: string | null;
}

export interface BufferPostStatus {
  id: string;
  /** unknown = the read did not get through; the post is left as it is. */
  status: "queued" | "posted" | "failed" | "unknown";
  url: string | null;
  error: string | null;
}

/** One post for one channel. `title` is the clip's hook (YouTube requires a title). */
export interface CreatePostArgs {
  channelId: string;
  platform: Platform;
  text: string;
  title: string;
  mediaUrl: string;
  scheduledAt: string;
  /** The clip carries an automatic or added voice over in her cloned voice: disclosed to the platform. */
  aiGenerated?: boolean;
  /** A full video for YouTube: the privacy she picked (Public / Unlisted / Private). */
  privacy?: "public" | "unlisted" | "private";
}

/**
 * Per-platform metadata Buffer requires. Found in the Phase 0 live test (26 Sep 2026): without it
 * Buffer refused every Instagram post ("Instagram posts require a type (post, story, or reel).")
 * and every YouTube post ("YouTube posts require a title., YouTube posts require a category.").
 * TikTok needs none. Category 26 = Howto & Style.
 */
export const YOUTUBE_CATEGORY_ID = "26";
//
// aiGenerated: a clip with a voice over in her cloned voice is AI-generated audio. Buffer's schema
// (introspected with the live key, 26 Sep 2026) has `isAiGenerated: Boolean` on
// TikTokPostMetadataInput, InstagramPostMetadataInput and YoutubePostMetadataInput ("Whether the
// post discloses AI-generated content"); each platform shows its own AI label from it.
export function postMetadata(platform: Platform, title: string, aiGenerated = false, privacy: "public" | "unlisted" | "private" = "public"): Record<string, unknown> | undefined {
  const ai = aiGenerated ? { isAiGenerated: true } : {};
  if (platform === "instagram") return { instagram: { type: "reel", shouldShareToFeed: true, ...ai } };
  if (platform === "youtube") {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 100) || "New video";
    // privacy: YoutubePrivacy enum (public | unlisted | private), introspected 26 Sep 2026.
    return { youtube: { title: t, categoryId: YOUTUBE_CATEGORY_ID, privacy, madeForKids: false, notifySubscribers: privacy === "public", ...ai } };
  }
  if (platform === "tiktok" && aiGenerated) return { tiktok: { isAiGenerated: true } };
  return undefined;
}

export interface BufferClient {
  checkKey(): Promise<{ ok: boolean; channels: BufferChannel[]; error: string | null; organizationId?: string }>;
  createPost(input: CreatePostArgs): Promise<{ ok: boolean; id: string | null; error: string | null }>;
  getPost(id: string): Promise<BufferPostStatus>;
  deletePost(id: string): Promise<boolean>;
  /** Posts waiting in the channel's queue; -1 when Buffer could not say. */
  queueCount(channelId: string): Promise<number>;
}

// ---- fake: realistic answers including the failure shapes tests need.
// Stateful across calls in one Worker isolate so the hourly sync can be exercised end to end:
//   createPost → the post sits "queued" in the channel (queueCount counts it); the sync only
//   reads a post back once its time has come, and the fake answers that read "posted" (the
//   fake compresses the platform's publish into that one read). A media link containing
//   "fail" is accepted and then fails on every read; one containing "reject" is refused at
//   create. queueCount = created, not yet read back, not deleted.
// An id the fake has never seen (the isolate restarted) reads as posted, or failed if it
// carries "fail", so a restart never strands a post.
interface FakePostState {
  channelId: string;
  reads: number;
  fail: boolean;
  deleted: boolean;
  /** What the real client would send as metadata (tests read it: the AI disclosure). */
  metadata: Record<string, unknown> | undefined;
}
const FAKE_POSTS = new Map<string, FakePostState>();

/** Test hook: forget every fake post (unit tests start from an empty Buffer). */
export function resetFakeBuffer(): void {
  FAKE_POSTS.clear();
}

/** Test hook: the metadata the fake was given for a post (the same postMetadata the real client sends). */
export function fakePostMetadata(id: string): Record<string, unknown> | undefined {
  return FAKE_POSTS.get(id)?.metadata;
}

export class FakeBuffer implements BufferClient {
  constructor(private key: string | null) {}
  async checkKey() {
    if (!this.key) return { ok: false, channels: [], error: "No key pasted yet." };
    if (this.key.startsWith("bad")) return { ok: false, channels: [], error: "Buffer says this key is not valid." };
    if (this.key.startsWith("expired")) return { ok: false, channels: [], error: "Buffer says this key has expired." };
    // "no-channels": a real Buffer account where nothing has been added yet (her state on 25 Sep).
    if (this.key.includes("no-channels")) return { ok: true, channels: [], error: null, organizationId: "fake_org" };
    const channels: BufferChannel[] = [
      { id: "ch_tiktok", platform: "tiktok", handle: "@sample.creator", connected: true },
      { id: "ch_instagram", platform: "instagram", handle: "@samplechannel", connected: !this.key.includes("ig-missing"), service_id: "17841400000000001", link: "https://instagram.com/samplechannel" },
      { id: "ch_youtube", platform: "youtube", handle: "Sample Creator", connected: true, service_id: "UCfakeSampleCreator0001", link: "https://www.youtube.com/channel/UCfakeSampleCreator0001" },
    ];
    return { ok: true, channels, error: null, organizationId: "fake_org" };
  }
  async createPost(input: CreatePostArgs) {
    if (!this.key) return { ok: false, id: null, error: "Buffer is not connected." };
    // The fake refuses what real Buffer refuses (see postMetadata).
    if (input.platform === "youtube" && !input.title.trim()) return { ok: false, id: null, error: "Invalid post: YouTube posts require a title." };
    if (input.mediaUrl.includes("reject")) return { ok: false, id: null, error: "Buffer rejected the video (too long for this channel)." };
    const fail = input.mediaUrl.includes("fail");
    const id = `fake_post_${fail ? "fail_" : ""}${Math.random().toString(36).slice(2, 10)}`;
    FAKE_POSTS.set(id, { channelId: input.channelId, reads: 0, fail, deleted: false, metadata: postMetadata(input.platform, input.title, !!input.aiGenerated, input.privacy) });
    return { ok: true, id, error: null };
  }
  async getPost(id: string): Promise<BufferPostStatus> {
    const st = FAKE_POSTS.get(id);
    if (!st) {
      if (id.includes("fail")) return { id, status: "failed", url: null, error: "The platform rejected the upload." };
      return { id, status: "posted", url: `https://example.invalid/post/${id}`, error: null };
    }
    st.reads++;
    if (st.fail) return { id, status: "failed", url: null, error: "The platform rejected the upload." };
    return { id, status: "posted", url: `https://example.invalid/post/${id}`, error: null };
  }
  async deletePost(id: string) {
    const st = FAKE_POSTS.get(id);
    if (st) st.deleted = true;
    return true;
  }
  async queueCount(channelId: string) {
    let n = 0;
    for (const st of FAKE_POSTS.values()) if (st.channelId === channelId && !st.deleted && !st.fail && st.reads === 0) n++;
    return n;
  }
}

// ---- real: GraphQL at https://api.buffer.com with the personal key (Bearer).
// Shapes CONFIRMED against a live key on 25 Sep 2026 (coordinator probe): account →
// organizations; channels(input:{organizationId}) with service / isDisconnected /
// isQueuePaused; createPost(input: CreatePostInput!) with mode customScheduled + dueAt +
// schedulingType automatic + needsApproval false; post(input:{id}) status enum
// (draft | error | needs_approval | scheduled | sending | sent); deletePost(input:{id});
// the PostActionSuccess | MutationError result union.
// NOT YET PROVEN (could not be introspected without the key): the AssetInput shape for a
// video by URL (VIDEO_ASSET below), PostInputMetaData (a YouTube title may be required),
// the Service enum's exact casing (matched case-insensitively), the PostId / OrganizationId
// scalar names in variables, and the posts(...) connection shape used by queueCount.
const VIDEO_ASSET = (url: string) => ({ video: { url } });

/** HTTP requests sent to Buffer by this isolate (the free plan's budget counts requests, not method calls). */
export const bufferRequests = { n: 0 };

class RealBuffer implements BufferClient {
  private orgId: string | null = null;
  constructor(private key: string) {}
  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    bufferRequests.n++;
    const res = await fetch("https://api.buffer.com/", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) throw new Error("Buffer says this key is not valid.");
    if (res.status === 429) throw new Error("Buffer says we asked too often. We will try again next hour.");
    if (!res.ok) throw new Error(`Buffer answered ${res.status}`);
    const data = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (data.errors?.length) {
      const e = data.errors[0];
      if (e.extensions?.code === "UNAUTHENTICATED") throw new Error("Buffer says this key is not valid.");
      throw new Error(e.message.slice(0, 120));
    }
    return data.data as T;
  }
  private async organization(): Promise<string> {
    if (this.orgId) return this.orgId;
    const data = await this.gql<{ account: { id: string; organizations: { id: string; name: string }[] } }>(`query { account { id organizations { id name } } }`);
    const org = data.account.organizations[0]?.id;
    if (!org) throw new Error("Buffer shows no organization on this account.");
    this.orgId = org;
    return org;
  }
  async checkKey() {
    try {
      const org = await this.organization();
      // serviceId / externalLink CONFIRMED on a live key 25 Sep 2026: YouTube's serviceId is the
      // UC… channel id the Stats screen reads public numbers with (no Google sign-in).
      const data = await this.gql<{ channels: { id: string; name: string; service: string; displayName: string | null; isDisconnected: boolean; isQueuePaused: boolean; serviceId: string | null; externalLink: string | null }[] }>(
        `query { channels(input: { organizationId: ${JSON.stringify(org)} }) { id name service displayName isDisconnected isQueuePaused serviceId externalLink } }`,
      );
      const channels: BufferChannel[] = [];
      for (const ch of data.channels) {
        const platform = platformOf(ch.service);
        if (!platform || channels.some((c) => c.platform === platform)) continue;
        channels.push({ id: ch.id, platform, handle: ch.displayName || ch.name, connected: !ch.isDisconnected, paused: ch.isQueuePaused, service_id: ch.serviceId ?? null, link: ch.externalLink ?? null });
      }
      return { ok: true, channels, error: null, organizationId: org };
    } catch (e) {
      return { ok: false, channels: [], error: e instanceof Error ? e.message : "Buffer did not answer." };
    }
  }
  async createPost(input: CreatePostArgs) {
    try {
      const metadata = postMetadata(input.platform, input.title, !!input.aiGenerated, input.privacy);
      const data = await this.gql<{ createPost: { post?: { id: string }; message?: string } }>(
        `mutation($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`,
        {
          input: {
            channelId: input.channelId,
            text: input.text,
            assets: [VIDEO_ASSET(input.mediaUrl)],
            mode: "customScheduled",
            schedulingType: "automatic",
            needsApproval: false,
            dueAt: input.scheduledAt,
            ...(metadata ? { metadata } : {}),
          },
        },
      );
      if (data.createPost.post) return { ok: true, id: data.createPost.post.id, error: null };
      return { ok: false, id: null, error: data.createPost.message ?? "Buffer did not accept the post." };
    } catch (e) {
      return { ok: false, id: null, error: e instanceof Error ? e.message : "Buffer did not answer." };
    }
  }
  async getPost(id: string): Promise<BufferPostStatus> {
    try {
      const data = await this.gql<{ post: { id: string; status: string; error: { message?: string | null } | null; externalLink: string | null } | null }>(
        // `error` is an object (PostPublishingError): selecting it bare made Buffer refuse the whole
        // query, so every read came back "unknown" and no post was ever marked posted (live test).
        `query($id: PostId!) { post(input: { id: $id }) { id status error { message supportUrl } externalLink sentAt dueAt } }`,
        { id },
      );
      if (!data.post) return { id, status: "failed", url: null, error: "Buffer no longer has this post." };
      const s = data.post.status.toLowerCase();
      const err = data.post.error ? (data.post.error.message?.slice(0, 200) || "Buffer reported a problem with this post.") : null;
      return { id, status: s === "sent" ? "posted" : s === "error" ? "failed" : "queued", url: data.post.externalLink, error: err };
    } catch (e) {
      // A read that did not get through says nothing about the post: never count it as a failure.
      return { id, status: "unknown", url: null, error: e instanceof Error ? e.message : "Buffer did not answer." };
    }
  }
  async deletePost(id: string) {
    try {
      const data = await this.gql<{ deletePost: { __typename: string; message?: string } }>(
        `mutation($id: PostId!) { deletePost(input: { id: $id }) { __typename ... on MutationError { message } } }`,
        { id },
      );
      return !data.deletePost.message;
    } catch {
      return false;
    }
  }
  async queueCount(channelId: string) {
    try {
      const org = await this.organization();
      const data = await this.gql<{ posts: { edges: { node: { id: string } }[] } }>(
        `query($channelId: ChannelId!) { posts(first: 100, input: { organizationId: ${JSON.stringify(org)}, filter: { channelIds: [$channelId], status: [scheduled] } }) { edges { node { id } } } }`,
        { channelId },
      );
      return data.posts.edges.length;
    } catch {
      return -1; // unknown: the sync falls back to its own count
    }
  }
}

/** Buffer's Service enum → our platform, case-insensitively (the enum's casing is unproven). */
export function platformOf(service: string): Platform | null {
  const s = service.toLowerCase();
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("youtube")) return "youtube";
  return null;
}

export async function getBuffer(env: Env, keyOverride?: string): Promise<BufferClient> {
  const key = keyOverride ?? (await getConnectionSecret(env, "buffer"));
  if (fakeServices(env)) return new FakeBuffer(key);
  if (!key) {
    log.warn("buffer.nokey");
    return new FakeBuffer(null);
  }
  return new RealBuffer(key);
}
