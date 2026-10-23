// What a clip's post says, at the moment it goes out (studio fix, 23 Oct 2026).
//
// The clip engine writes the FINAL caption in the owner's exact layout:
//   caption body \n\n CTA line with the link \n\n hashtags \n\n — \n Made with AI
// (the "—" line keeps the AI note apart even where an app squashes blank lines). At post time the
// studio's link is swapped for a per-platform tracking link, so the request page can tell which
// platform and which clip sent each visitor:
//   utm_source=<platform> utm_medium=social utm_campaign=<studio slug> utm_content=<clip tag>
// Clips made before the final layout keep the old shape (caption, blank line, hashtags).
// Guard: tests/unit/post-text.test.ts pins the exact strings.

/** The divider and the note, exactly as the owner ruled. */
export const AI_NOTE_TAIL = "\n\n—\nMade with AI";

export const TRACK_SOURCES = ["tiktok", "instagram", "facebook", "pinterest", "youtube"] as const;
export type TrackSource = (typeof TRACK_SOURCES)[number];

/** The link with this platform's tracking added (any utm_* it already had is replaced). Pure. */
export function trackedLink(link: string, source: TrackSource, campaign: string, content: string): string {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
    u.searchParams.set("utm_source", source);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", campaign.toLowerCase());
    u.searchParams.set("utm_content", content);
    return u.toString();
  } catch {
    return link;
  }
}

/** True when the caption is already the engine's final layout (it carries its own hashtags and note). */
export const isFinalCaption = (caption: string): boolean => /\n\n—\n/.test(caption) || /\n\n#\S/.test(caption);

/** Every place the studio's link appears (with or without a trailing slash), swapped for the tracking link. */
export function swapLink(text: string, link: string, tracked: string): string {
  if (!link) return text;
  const bare = link.replace(/\/$/, "");
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The link as written, not already followed by a query (a link she typed with ?x= stays as it is).
  return text.replace(new RegExp(`${esc}/?(?![?\\w/-])`, "g"), tracked);
}

export interface PostTextInput {
  caption: string;
  hashtags: string;
  /** The clip carries something made with AI (a voice over, an AI picture, or the studio says every clip). */
  aiMade: boolean;
  /** The studio's call-to-action link ("" = none set). */
  link: string;
  source: TrackSource;
  campaign: string;
  /** "clip-1022-5b" (shared/clipNumber.ts clipTag). */
  tag: string;
}

/** The exact text a platform receives. Pure. */
export function postText(p: PostTextInput): string {
  const caption = String(p.caption ?? "").replace(/\r/g, "").trim();
  let text = isFinalCaption(caption) ? caption : [caption, String(p.hashtags ?? "").trim()].filter(Boolean).join("\n\n");
  if (p.aiMade && !/made with ai/i.test(text)) text = text ? `${text}${AI_NOTE_TAIL}` : AI_NOTE_TAIL.trim();
  return p.link ? swapLink(text, p.link, trackedLink(p.link, p.source, p.campaign, p.tag)) : text;
}
