// Photo posts: one photo becomes a pack of posts (a slow-zoom reel, a before/after when two photos
// exist, a carousel and three short captions) that go out on their own, each with a heads-up and
// a Skip. Per studio (studios/<slug>.json "photoPosts", var PHOTO_POSTS): on for Porch & Party
// (sample1) and Hadiyah, off elsewhere. Pure types and config shared by the Worker and the app.

export const SOCIALS = ["facebook", "instagram", "tiktok", "pinterest"] as const;
export type Social = (typeof SOCIALS)[number];

export const SOCIAL_LABEL: Record<Social, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", pinterest: "Pinterest" };

/** The Setup card that connects each platform (Instagram and TikTok post through Buffer). */
export const SOCIAL_SETUP: Record<Social, "facebook" | "pinterest" | "buffer"> = { facebook: "facebook", instagram: "buffer", tiktok: "buffer", pinterest: "pinterest" };

export interface PhotoPostsConfig {
  on: boolean;
  platforms: Social[];
  /** Hours between the heads-up email and the post going out (a post is never planned sooner). */
  headsUpHours: number;
  /** Local hour (studio time zone) posts go out. */
  postHour: number;
}

export const PHOTO_POSTS_OFF: PhotoPostsConfig = { on: false, platforms: [], headsUpHours: 24, postHour: 11 };

/** The studio's photo-post config from its var. Missing or malformed = off (a studio never gets it by accident). */
export function parsePhotoPosts(raw: string | undefined | null): PhotoPostsConfig {
  if (!raw || !raw.trim()) return PHOTO_POSTS_OFF;
  try {
    const j = JSON.parse(raw) as Partial<PhotoPostsConfig>;
    if (j.on !== true) return PHOTO_POSTS_OFF;
    const platforms = (Array.isArray(j.platforms) ? j.platforms : []).filter((p): p is Social => (SOCIALS as readonly string[]).includes(p as string));
    const headsUpHours = Number.isFinite(j.headsUpHours) && j.headsUpHours! >= 1 && j.headsUpHours! <= 72 ? Math.round(j.headsUpHours!) : 24;
    const postHour = Number.isInteger(j.postHour) && j.postHour! >= 6 && j.postHour! <= 21 ? j.postHour! : 11;
    return { on: true, platforms: [...new Set(platforms)], headsUpHours, postHour };
  } catch {
    return PHOTO_POSTS_OFF;
  }
}

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif"];
/** iPhone Safari sometimes sends no type for a HEIC photo: the file name decides then. */
export const PHOTO_EXT = /\.(jpe?g|png|heic|heif)$/i;
export const PHOTO_MAX_BYTES = 40 * 1024 * 1024;
export const PACK_MAX_PHOTOS = 10;

export const isPhoto = (mime: string, name = ""): boolean => PHOTO_TYPES.includes(mime.toLowerCase()) || ((!mime || mime === "application/octet-stream") && PHOTO_EXT.test(name));

export type ItemKind = "reel" | "before_after" | "carousel";
export const ITEM_LABEL: Record<ItemKind, string> = { reel: "Photo video", before_after: "Before and after video", carousel: "Photo set" };
/** Made or moved by the studio's tools: carries the platform AI flag or the "Made with AI" label. */
export const AI_MADE: Record<ItemKind, boolean> = { reel: true, before_after: true, carousel: false };

/** Which platform gets which piece, and on which day of the pack (1 = first). */
export const PACK_PLAN: { kind: ItemKind; day: number; platforms: Social[] }[] = [
  { kind: "reel", day: 1, platforms: ["facebook", "instagram", "tiktok"] },
  { kind: "carousel", day: 2, platforms: ["facebook", "pinterest"] },
  { kind: "before_after", day: 3, platforms: ["facebook", "instagram", "tiktok"] },
];

export type SocialPostStatus = "scheduled" | "waiting" | "sending" | "posted" | "skipped" | "failed" | "held";

export interface PackPhotoView {
  id: string;
  role: "main" | "before" | "after";
  url: string;
}

export interface PackItemView {
  id: string;
  kind: ItemKind;
  label: string;
  ai_made: boolean;
  /** null while the photo maker has not made it (practice mode). */
  media_url: string | null;
  cover_url: string | null;
  images: string[];
}

export interface SocialPostView {
  id: string;
  pack_id: string;
  item_kind: ItemKind;
  platform: Social;
  caption: string;
  scheduled_at: string;
  status: SocialPostStatus;
  /** The plain line under it ("Goes out Thu 11 AM", "Waiting: Connect Facebook"). */
  line: string;
  /** The Setup card to open when it waits on a connection. */
  connect: string | null;
  url: string | null;
  cover_url: string | null;
}

export interface PackView {
  id: string;
  status: "uploading" | "making" | "ready" | "failed";
  note: string;
  created_at: string;
  privacy: "unchecked" | "clean" | "fixed" | "blocked";
  privacy_line: string;
  error: string | null;
  photos: PackPhotoView[];
  /**
   * The set's picture on its card: the photo maker's checked (blurred) picture once made, else the
   * first upload a browser can show (JPEG/PNG/WebP), else none. 22 Oct 2026: an iPhone HEIC upload
   * showed as a broken image on the card.
   */
  thumb_url: string | null;
  items: PackItemView[];
  captions: string[];
  posts: SocialPostView[];
}

export interface PhotosHome {
  on: boolean;
  /** Plain line when off for this studio. */
  off_line: string | null;
  /** Platforms that are not connected yet, as "Connect Facebook" stops. */
  stops: { platform: Social; label: string; setup: string; why: string }[];
  /** The photo maker (Clip cutting) is in practice: reels wait until it is connected. */
  maker_practice: boolean;
  upcoming: SocialPostView[];
  packs: PackView[];
  rules: { banWords: string[]; prices: string; blockAddresses: boolean; blockFaces: boolean };
}

/** The one-time "What's new" note (studios/<slug>.json "whatsNew", var WHATS_NEW). */
export interface WhatsNew {
  id: string;
  title: string;
  lines: string[];
}

export function parseWhatsNew(raw: string | undefined | null): WhatsNew | null {
  if (!raw || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as Partial<WhatsNew>;
    const lines = (Array.isArray(j.lines) ? j.lines : []).filter((l): l is string => typeof l === "string" && !!l.trim()).slice(0, 5);
    if (!j.id || typeof j.id !== "string" || !lines.length) return null;
    return { id: j.id.slice(0, 64), title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : "What's new", lines };
  } catch {
    return null;
  }
}
