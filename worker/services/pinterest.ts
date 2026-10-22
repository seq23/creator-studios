// Pinterest pins through the Pinterest API v5 (free), with the access token and board pasted on
// Setup → Pinterest (stored encrypted; or the Worker secrets PINTEREST_ACCESS_TOKEN /
// PINTEREST_BOARD_ID). An AI-made piece carries the "Made with AI" label in its description.
// Fake first: a token starting "bad" is refused, an image link containing "fail" fails to pin.
import type { Env } from "../env";
import { fakeServices } from "../env";
import type { KeyCheck } from "./keychecks";
import type { PostResult } from "./facebook";

const API = "https://api.pinterest.com/v5";

export interface PinterestClient {
  checkKey(): Promise<KeyCheck>;
  createPin(input: { imageUrl: string; title: string; text: string; link: string | null }): Promise<PostResult>;
}

/** Pinterest's error, in plain words. Pure. */
export function pinterestRefusal(status: number): string {
  if (status === 401) return "Pinterest says the access token has run out or was changed. Connect Pinterest again on Setup.";
  if (status === 403) return "Pinterest says this token may not pin to that board. Make a token with pins:write.";
  if (status === 404) return "Pinterest cannot find that board. Check the board id on Setup.";
  if (status === 429) return "Pinterest asked us to slow down. It will try again next hour.";
  return `Pinterest answered ${status}. It will try again next hour.`;
}

export class FakePinterest implements PinterestClient {
  static pinned: { text: string; image: string }[] = [];
  constructor(private token: string | null) {}
  async checkKey(): Promise<KeyCheck> {
    if (!this.token || this.token.startsWith("bad")) return { ok: false, error: "Pinterest says this access token is not valid.", meta: {} };
    return { ok: true, error: null, meta: { board: "Practice board" } };
  }
  async createPin(input: { imageUrl: string; title: string; text: string }): Promise<PostResult> {
    if (input.imageUrl.includes("fail")) return { ok: false, id: null, url: null, error: "Pinterest answered 500. It will try again next hour." };
    FakePinterest.pinned.push({ text: input.text, image: input.imageUrl });
    const id = `pin_${FakePinterest.pinned.length}`;
    return { ok: true, id, url: `https://www.pinterest.com/pin/${id}/`, error: null };
  }
}

class RealPinterest implements PinterestClient {
  constructor(private token: string, private boardId: string) {}
  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }
  async checkKey(): Promise<KeyCheck> {
    try {
      const res = await fetch(`${API}/boards/${encodeURIComponent(this.boardId)}`, { headers: this.headers() });
      if (!res.ok) return { ok: false, error: pinterestRefusal(res.status), meta: {} };
      const j = (await res.json()) as { name?: string };
      return { ok: true, error: null, meta: { board: j.name ?? "" } };
    } catch {
      return { ok: false, error: "Pinterest could not be reached. Try again in a minute.", meta: {} };
    }
  }
  async createPin(input: { imageUrl: string; title: string; text: string; link: string | null }): Promise<PostResult> {
    try {
      const res = await fetch(`${API}/pins`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          board_id: this.boardId,
          title: input.title.slice(0, 100),
          description: input.text.slice(0, 500),
          ...(input.link ? { link: input.link } : {}),
          media_source: { source_type: "image_url", url: input.imageUrl },
        }),
      });
      if (res.status !== 201 && res.status !== 200) return { ok: false, id: null, url: null, error: pinterestRefusal(res.status) };
      const id = String(((await res.json()) as { id?: string }).id ?? "");
      return { ok: !!id, id: id || null, url: id ? `https://www.pinterest.com/pin/${id}/` : null, error: id ? null : "Pinterest did not say the pin went up." };
    } catch {
      return { ok: false, id: null, url: null, error: "Pinterest could not be reached. It will try again next hour." };
    }
  }
}

export const pinterestConnected = (env: Pick<Env, "PINTEREST_ACCESS_TOKEN" | "PINTEREST_BOARD_ID" | "FAKE_SERVICES">): boolean => fakeServices(env as Env) || !!(env.PINTEREST_ACCESS_TOKEN && env.PINTEREST_BOARD_ID);

export function getPinterest(env: Env, override?: { token: string; boardId: string }): PinterestClient {
  const token = override?.token ?? env.PINTEREST_ACCESS_TOKEN ?? "";
  const boardId = override?.boardId ?? env.PINTEREST_BOARD_ID ?? "";
  if (fakeServices(env)) return new FakePinterest(token || "fake-token");
  return new RealPinterest(token, boardId);
}
