// Facebook Page posting through the Graph API (free), with the Page token pasted on Setup →
// Facebook Page (stored encrypted; or the Worker secrets FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN).
// The Graph API has no AI-content field for Page posts, so an AI-made piece carries the "Made with
// AI" caption label instead (shared/contentRules.ts withAiLabel, applied by worker/lib/photoPosts.ts).
// Fake first: a token starting "bad" is refused, a media link containing "fail" fails to post.
import type { Env } from "../env";
import { fakeServices } from "../env";
import type { KeyCheck } from "./keychecks";

const GRAPH = "https://graph.facebook.com/v21.0";
const GRAPH_VIDEO = "https://graph-video.facebook.com/v21.0";

export interface PostResult {
  ok: boolean;
  id: string | null;
  url: string | null;
  error: string | null;
}

export interface FacebookClient {
  checkKey(): Promise<KeyCheck>;
  postVideo(input: { videoUrl: string; text: string }): Promise<PostResult>;
  postPhotos(input: { imageUrls: string[]; text: string }): Promise<PostResult>;
}

/** Facebook's error, in plain words. Pure. */
export function facebookRefusal(status: number, body: string): string {
  let code = 0;
  try {
    code = Number((JSON.parse(body) as { error?: { code?: number } }).error?.code ?? 0);
  } catch {
    code = 0;
  }
  if (code === 190 || status === 401) return "Facebook says the Page token has run out or was changed. Connect Facebook again on Setup.";
  if (code === 200 || code === 10 || status === 403) return "Facebook says this token may not post to the Page. Make a new Page token with pages_manage_posts.";
  if (code === 4 || code === 32 || status === 429) return "Facebook asked us to slow down. It will try again next hour.";
  return `Facebook answered ${status}. It will try again next hour.`;
}

export class FakeFacebook implements FacebookClient {
  static posted: { kind: "video" | "photos"; text: string; media: string[] }[] = [];
  constructor(private token: string | null) {}
  async checkKey(): Promise<KeyCheck> {
    if (!this.token || this.token.startsWith("bad")) return { ok: false, error: "Facebook says this Page token is not valid.", meta: {} };
    return { ok: true, error: null, meta: { page: "Practice Page" } };
  }
  async postVideo(input: { videoUrl: string; text: string }): Promise<PostResult> {
    if (input.videoUrl.includes("fail")) return { ok: false, id: null, url: null, error: "Facebook answered 500. It will try again next hour." };
    FakeFacebook.posted.push({ kind: "video", text: input.text, media: [input.videoUrl] });
    const id = `fbv_${FakeFacebook.posted.length}`;
    return { ok: true, id, url: `https://www.facebook.com/${id}`, error: null };
  }
  async postPhotos(input: { imageUrls: string[]; text: string }): Promise<PostResult> {
    if (input.imageUrls.some((u) => u.includes("fail"))) return { ok: false, id: null, url: null, error: "Facebook answered 500. It will try again next hour." };
    FakeFacebook.posted.push({ kind: "photos", text: input.text, media: input.imageUrls });
    const id = `fbp_${FakeFacebook.posted.length}`;
    return { ok: true, id, url: `https://www.facebook.com/${id}`, error: null };
  }
}

class RealFacebook implements FacebookClient {
  constructor(private pageId: string, private token: string) {}
  private async form(url: string, fields: Record<string, string>): Promise<{ status: number; body: string }> {
    const res = await fetch(url, { method: "POST", body: new URLSearchParams({ ...fields, access_token: this.token }) });
    return { status: res.status, body: await res.text() };
  }
  async checkKey(): Promise<KeyCheck> {
    try {
      const res = await fetch(`${GRAPH}/${encodeURIComponent(this.pageId)}?fields=id,name&access_token=${encodeURIComponent(this.token)}`);
      const body = await res.text();
      if (!res.ok) return { ok: false, error: facebookRefusal(res.status, body), meta: {} };
      const j = JSON.parse(body) as { name?: string };
      return { ok: true, error: null, meta: { page: j.name ?? "" } };
    } catch {
      return { ok: false, error: "Facebook could not be reached. Try again in a minute.", meta: {} };
    }
  }
  async postVideo(input: { videoUrl: string; text: string }): Promise<PostResult> {
    try {
      const r = await this.form(`${GRAPH_VIDEO}/${encodeURIComponent(this.pageId)}/videos`, { file_url: input.videoUrl, description: input.text, published: "true" });
      if (r.status !== 200) return { ok: false, id: null, url: null, error: facebookRefusal(r.status, r.body) };
      const id = String((JSON.parse(r.body) as { id?: string }).id ?? "");
      return { ok: !!id, id: id || null, url: id ? `https://www.facebook.com/${this.pageId}/videos/${id}` : null, error: id ? null : "Facebook did not say the video was posted." };
    } catch {
      return { ok: false, id: null, url: null, error: "Facebook could not be reached. It will try again next hour." };
    }
  }
  async postPhotos(input: { imageUrls: string[]; text: string }): Promise<PostResult> {
    try {
      const ids: string[] = [];
      for (const url of input.imageUrls.slice(0, 10)) {
        const r = await this.form(`${GRAPH}/${encodeURIComponent(this.pageId)}/photos`, { url, published: "false" });
        if (r.status !== 200) return { ok: false, id: null, url: null, error: facebookRefusal(r.status, r.body) };
        ids.push(String((JSON.parse(r.body) as { id?: string }).id ?? ""));
      }
      const fields: Record<string, string> = { message: input.text };
      ids.forEach((id, i) => (fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const r = await this.form(`${GRAPH}/${encodeURIComponent(this.pageId)}/feed`, fields);
      if (r.status !== 200) return { ok: false, id: null, url: null, error: facebookRefusal(r.status, r.body) };
      const id = String((JSON.parse(r.body) as { id?: string }).id ?? "");
      return { ok: !!id, id: id || null, url: id ? `https://www.facebook.com/${id}` : null, error: id ? null : "Facebook did not say the post went up." };
    } catch {
      return { ok: false, id: null, url: null, error: "Facebook could not be reached. It will try again next hour." };
    }
  }
}

/** Whether the Page is connected (after hydrate: stored first, then Worker secrets). */
export const facebookConnected = (env: Pick<Env, "FACEBOOK_PAGE_ID" | "FACEBOOK_PAGE_TOKEN" | "FAKE_SERVICES">): boolean => fakeServices(env as Env) || !!(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_TOKEN);

export function getFacebook(env: Env, override?: { pageId: string; token: string }): FacebookClient {
  const pageId = override?.pageId ?? env.FACEBOOK_PAGE_ID ?? "";
  const token = override?.token ?? env.FACEBOOK_PAGE_TOKEN ?? "";
  if (fakeServices(env)) return new FakeFacebook(token || "fake-token");
  return new RealFacebook(pageId, token);
}
