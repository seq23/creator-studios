// YouTube public numbers with an API key, no sign-in (owner decision 25 Sep 2026: production
// Stats is no-login; Sam never sees a Google consent screen). YouTube Data API v3 with the
// Worker secret YOUTUBE_API_KEY: a channel's subscriberCount / viewCount / videoCount and each
// upload's views, likes, comments, publishedAt and title are public, so a key is enough.
// Quota: channels.list and playlistItems.list and videos.list cost 1 unit each (a sync is 3
// to 5 units of the free 10,000 a day); search.list costs 100 and is used once, only when the
// channel cannot be found any other way, and its answer is remembered.
//
// FAKE_SERVICES=1: a fake with the failure shapes (a handle containing "missing" finds no
// channel; "quota" answers quotaExceeded; "badkey" a refused key).
import type { Env } from "../env";
import { fakeServices } from "../env";
import { log } from "../lib/log";

export interface YouTubeChannel {
  id: string;
  title: string;
  handle: string | null;
  subscribers: number;
  views: number;
  videos: number;
  uploads: string | null;
}

export interface YouTubeVideo {
  id: string;
  title: string | null;
  published_at: string | null;
  views: number;
  likes: number;
  comments: number;
}

/** Why a call did not get numbers, in the words the Stats screen and the light use. */
export type YouTubeFailure = "no_key" | "key_refused" | "quota" | "not_found" | "failed";

export class YouTubeError extends Error {
  constructor(public kind: YouTubeFailure) {
    super(kind);
  }
}

export interface YouTubePublicClient {
  channelById(id: string): Promise<YouTubeChannel | null>;
  channelByHandle(handle: string): Promise<YouTubeChannel | null>;
  /** search.list (100 units): the channel ids whose title matches, best first. */
  searchChannels(name: string): Promise<{ id: string; title: string }[]>;
  /** Newest uploads first, at most `max`. An empty channel (no uploads playlist yet) is []. */
  uploads(playlistId: string, max: number): Promise<YouTubeVideo[]>;
}

const YT = "https://www.googleapis.com/youtube/v3";
const num = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));

class RealYouTube implements YouTubePublicClient {
  constructor(private key: string) {}
  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${YT}/${path}?${new URLSearchParams({ ...params, key: this.key })}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new YouTubeError("failed");
    }
    if (res.ok) return (await res.json()) as T;
    const body = await res.text().catch(() => "");
    if (res.status === 404 && /playlistNotFound/.test(body)) throw new YouTubeError("not_found");
    if (/quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(body)) throw new YouTubeError("quota");
    if (res.status === 400 && /keyInvalid|API key not valid/.test(body)) throw new YouTubeError("key_refused");
    if (res.status === 403 && /(accessNotConfigured|forbidden|API_KEY|keyExpired|ipRefererBlocked|SERVICE_DISABLED)/i.test(body)) throw new YouTubeError("key_refused");
    log.warn("youtube.http", { status: res.status });
    throw new YouTubeError("failed");
  }
  private toChannel(item: { id: string; snippet?: { title?: string; customUrl?: string }; statistics?: Record<string, string>; contentDetails?: { relatedPlaylists?: { uploads?: string } } }): YouTubeChannel {
    return {
      id: item.id,
      title: item.snippet?.title ?? "",
      handle: item.snippet?.customUrl ?? null,
      subscribers: num(item.statistics?.subscriberCount),
      views: num(item.statistics?.viewCount),
      videos: num(item.statistics?.videoCount),
      uploads: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  }
  private async channel(params: Record<string, string>): Promise<YouTubeChannel | null> {
    const d = await this.get<{ items?: Parameters<RealYouTube["toChannel"]>[0][] }>("channels", { part: "snippet,statistics,contentDetails", ...params });
    return d.items?.[0] ? this.toChannel(d.items[0]) : null;
  }
  channelById(id: string) {
    return this.channel({ id });
  }
  channelByHandle(handle: string) {
    return this.channel({ forHandle: handle.startsWith("@") ? handle : `@${handle}` });
  }
  async searchChannels(name: string) {
    const d = await this.get<{ items?: { id: { channelId: string }; snippet: { title: string } }[] }>("search", { part: "snippet", type: "channel", maxResults: "5", q: name });
    return (d.items ?? []).map((i) => ({ id: i.id.channelId, title: i.snippet.title }));
  }
  async uploads(playlistId: string, max: number) {
    const ids: string[] = [];
    let pageToken: string | undefined;
    try {
      while (ids.length < max) {
        const page = await this.get<{ items?: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>("playlistItems", {
          part: "contentDetails",
          playlistId,
          maxResults: "50",
          ...(pageToken ? { pageToken } : {}),
        });
        ids.push(...(page.items ?? []).map((i) => i.contentDetails.videoId));
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      // A channel that has never uploaded has no uploads playlist yet: zero videos, not an error.
      if (e instanceof YouTubeError && e.kind === "not_found") return [];
      throw e;
    }
    const out: YouTubeVideo[] = [];
    for (let i = 0; i < Math.min(ids.length, max); i += 50) {
      const batch = ids.slice(i, Math.min(i + 50, max));
      const d = await this.get<{ items?: { id: string; snippet?: { title?: string; publishedAt?: string }; statistics?: Record<string, string> }[] }>("videos", { part: "snippet,statistics", id: batch.join(",") });
      for (const v of d.items ?? []) {
        out.push({ id: v.id, title: v.snippet?.title?.slice(0, 300) || null, published_at: v.snippet?.publishedAt ?? null, views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount) });
      }
    }
    return out;
  }
}

// ---- fake: one channel with six weeks of uploads, plus the failure shapes.
// Realistic titles (the fake stands in on the public sample too, so no "fake" or "test" on a screen).
const FAKE_TITLES = ["Set a Sunday brunch table in 60 seconds", "The one napkin fold everyone asks about", "Candles, but make it fall", "Thanksgiving table on a budget", "Three pieces that make a holiday table", "How I reset after guests leave", "The easiest centerpiece ever", "Stop buying placemats: do this", "My go-to trick for a garden party", "Thrifted plates, luxury table", "The layering rule for a summer table", "Florals from the grocery store"];
const FAKE_CHANNEL: YouTubeChannel = { id: "UCfakeSampleCreator0001", title: "Sample Creator", handle: "@tableandgather", subscribers: 1260, views: 48_300, videos: 12, uploads: "UUfakeSampleCreator0001" };

class FakeYouTube implements YouTubePublicClient {
  constructor(private key: string) {}
  private guard(hint = "") {
    if (this.key.includes("badkey") || hint.includes("badkey")) throw new YouTubeError("key_refused");
    if (this.key.includes("quota") || hint.includes("quota")) throw new YouTubeError("quota");
  }
  async channelById(id: string) {
    this.guard(id);
    return id === FAKE_CHANNEL.id || id.startsWith("UCfake") ? { ...FAKE_CHANNEL, id } : null;
  }
  async channelByHandle(handle: string) {
    this.guard(handle);
    if (handle.includes("missing")) return null;
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    return { ...FAKE_CHANNEL, handle: h.toLowerCase(), title: h.slice(1) };
  }
  async searchChannels(name: string) {
    this.guard(name);
    if (name.includes("missing")) return [];
    return [{ id: FAKE_CHANNEL.id, title: name }];
  }
  async uploads(playlistId: string, max: number) {
    void playlistId;
    const out: YouTubeVideo[] = [];
    for (let i = 0; i < Math.min(12, max); i++) {
      const d = new Date(Date.now() - (i * 42 * 86_400_000) / 12 - 86_400_000);
      d.setUTCHours([13, 17, 23][i % 3], 0, 0, 0);
      const views = [5200, 3100, 2400, 1800, 6400, 2900, 2200, 1500, 4100, 3300, 2600, 1900][i];
      out.push({ id: `fakeYt${String(i).padStart(5, "0")}`, title: FAKE_TITLES[i], published_at: d.toISOString(), views, likes: Math.round(views * 0.05), comments: Math.round(views * 0.006) });
    }
    return out;
  }
}

/** The public-numbers client, or null when there is no key (the Stats screen names that stop). */
export function getYouTubePublic(env: Env): YouTubePublicClient | null {
  if (fakeServices(env)) return new FakeYouTube(env.YOUTUBE_API_KEY ?? "fake-key");
  // Practice mode (no YouTube key yet, on Setup or the host's): no numbers are invented for her
  // channel; Stats names the state ("no_key") and points at Setup. Sample numbers would be stored
  // as hers, so practice here is the labelled wait, not a stand-in.
  if (!env.YOUTUBE_API_KEY) return null;
  return new RealYouTube(env.YOUTUBE_API_KEY);
}
