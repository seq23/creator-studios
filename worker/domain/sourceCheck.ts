// "Looks like someone else's video" (Phase 0 live test, 25 Sep 2026: a dump of downloaded
// TikToks carried another creator's burned-in watermark "TikTok @texasgardenfairyx", and nothing
// stopped its clips from reaching the calendar and Buffer). The cut job reads a few frames of
// each video (OCR) and reports any platform watermark and @handles it saw; this decides whose
// video it is. Her own recycled TikToks carry HER handle and are fine; another handle, or a
// watermark whose handle cannot be read while hers is unknown, holds the video's clips off the
// calendar until she taps "This is my video" on the dump.

export type SourceOwner = "hers" | "other" | "confirmed";

export interface SourceMark {
  asset_id: string;
  platform: string | null; // "tiktok" | "instagram" watermark seen, or null
  handles: string[]; // as read, without "@"
}

/** Lowercase letters and digits only: OCR drops or doubles dots and underscores. */
export function normalizeHandle(h: string): string {
  return h.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Same handle, allowing one OCR slip per 8 characters (never for handles under 5 characters). */
export function sameHandle(read: string, own: string): boolean {
  const a = normalizeHandle(read);
  const b = normalizeHandle(own);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return editDistance(a, b) <= Math.floor(Math.max(a.length, b.length) / 8);
}

/**
 * Whose video: `null` = nothing seen (no watermark, no handle), leave it alone. Every handle read
 * must be one of hers (her Buffer channels' handles). A watermark with no readable handle is held
 * too: one tap on "This is my video" clears it, a wrong guess the other way posts someone else's
 * video.
 */
export function sourceVerdict(mark: Pick<SourceMark, "platform" | "handles">, ownHandles: string[]): { owner: SourceOwner; foreign: string[] } | null {
  const handles = [...new Set(mark.handles.map((h) => h.replace(/^@/, "")).filter((h) => normalizeHandle(h).length >= 2))];
  // A handle with no platform watermark is usually her own tag of a venue or brand: not a sign.
  if (!mark.platform) return null;
  const foreign = handles.filter((h) => !ownHandles.some((o) => sameHandle(h, o)));
  if (foreign.length) return { owner: "other", foreign };
  if (handles.length) return { owner: "hers", foreign: [] };
  return { owner: "other", foreign: [] }; // a watermark, but whose cannot be read
}

/** The one SQL rule for "this clip may go on the calendar and to Buffer" (alias c = clips). */
export const POSTABLE_CLIP_SQL = "c.status = 'approved' AND c.file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM assets sa WHERE sa.id = c.asset_id AND sa.source_owner = 'other')";

export function heldSentence(foreign: string[], platform: string | null): string {
  const where = platform === "tiktok" ? "a TikTok watermark" : platform === "instagram" ? "an Instagram watermark" : "a creator's handle";
  const who = foreign.length ? ` for @${foreign.slice(0, 2).join(", @")}` : "";
  return `Looks like someone else's video: we saw ${where}${who}. Its clips stay off your calendar. If it is your own video, tap This is my video.`;
}
