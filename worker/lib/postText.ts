// The text a clip's post carries when it goes to a platform (studio fix, 23 Oct 2026): the engine's
// final caption (shared/postText.ts layout), "Made with AI" where this studio asks for it, and the
// studio's link swapped for this platform's tracking link (utm_source=<platform>, utm_medium=social,
// utm_campaign=<studio slug>, utm_content=<clip tag>). The link used is recorded on the post.
import type { Env } from "../env";
import { readStudioRules } from "./studioRules";
import { postText, trackedLink, type TrackSource } from "@shared/postText";
import { clipTag } from "@shared/clipNumber";
import { studioSlug } from "../env";

export interface ClipForPost {
  caption: string;
  hashtags: string;
  ai_voice: number;
  uses_ai_images?: number | null;
  number?: number | null;
  version?: number | null;
  dump_created_at?: string | null;
  /** The engine's clip type: set (and not "imported") = the caption is final, sent as written. */
  clip_type?: string | null;
}

/** SQL columns the post loaders add so clipPostText has what it needs (c = clips). */
export const POST_TEXT_COLUMNS = "c.clip_type, c.uses_ai_images, c.number, c.version, (SELECT d.created_at FROM dumps d WHERE d.id = c.dump_id) AS dump_created_at";

export async function clipPostText(env: Env, row: ClipForPost, source: TrackSource): Promise<{ text: string; link: string | null; aiMade: boolean }> {
  const rules = await readStudioRules(env);
  const aiMade = row.ai_voice > 0 || rules.ai_note === "all" || !!row.uses_ai_images;
  const tag = clipTag(row.dump_created_at ?? "", row.number ?? null, row.version ?? 1, env.AUDIENCE_TIMEZONE);
  const campaign = studioSlug(env);
  const final = !!row.clip_type && row.clip_type !== "imported";
  const text = postText({ caption: row.caption, hashtags: row.hashtags, aiMade, link: rules.cta_link, source, campaign, tag, final });
  return { text, link: rules.cta_link ? trackedLink(rules.cta_link, source, campaign, tag) : null, aiMade };
}
