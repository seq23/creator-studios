// Clip numbers (studio fix, 23 Oct 2026): every clip of a dump gets the next number in that dump's
// own sequence the moment it is made ("Oct 22 · Clip 5"). A number is never reused or renumbered,
// even when a clip is rejected, deleted or the dump starts over (dumps.clip_seq only goes up).
// Each new version of the same clip keeps its number and takes the next letter: 5, 5b, 5c.
// Shown on Review cards, emails, the Calendar and the What I dumped page; Review's search finds it.
// Guard: tests/unit/clip-numbers.test.ts.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "", "b", "c" … for versions 1, 2, 3 … (26 at most, then it stays "z"). */
export function versionLetter(version: number): string {
  const v = Math.max(1, Math.floor(Number(version) || 1));
  return v === 1 ? "" : String.fromCharCode(96 + Math.min(26, v));
}

/** "5b": the number and its version letter; "" when the clip has no number (made before numbers). */
export function clipCode(n: number | null | undefined, version = 1): string {
  return n && n > 0 ? `${n}${versionLetter(version)}` : "";
}

/** "Oct 22": the dump's day in the audience's time zone. */
export function dumpDay(iso: string, timeZone = "America/New_York"): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(d);
  const m = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${MONTHS[m - 1]} ${day}`;
}

/** "Oct 22 · Clip 5b", or "" for a clip with no number. */
export function clipLabel(dumpCreatedAt: string, n: number | null | undefined, version = 1, timeZone?: string): string {
  const code = clipCode(n, version);
  return code ? `${dumpDay(dumpCreatedAt, timeZone)} · Clip ${code}` : "";
}

/** The tracking tag for a clip's links: "clip-1022-5b" (month+day of its dump, then its code). */
export function clipTag(dumpCreatedAt: string, n: number | null | undefined, version = 1, timeZone?: string): string {
  const code = clipCode(n, version);
  const d = new Date(dumpCreatedAt.endsWith("Z") || dumpCreatedAt.includes("+") ? dumpCreatedAt : `${dumpCreatedAt}Z`);
  if (!code || Number.isNaN(d.getTime())) return "clip";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? "America/New_York", month: "2-digit", day: "2-digit" }).formatToParts(d);
  return `clip-${parts.find((p) => p.type === "month")?.value}${parts.find((p) => p.type === "day")?.value}-${code}`;
}

/**
 * A search that is a clip number: "5", "clip 5", "#5", "5b", "Clip 5c". Returns the number and,
 * when a letter was typed, the version; null for any other search.
 */
export function parseClipSearch(q: string): { n: number; version: number | null } | null {
  const m = /^\s*(?:clip\s*)?#?\s*(\d{1,4})\s*([a-z])?\s*$/i.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const letter = m[2]?.toLowerCase();
  return { n, version: letter ? (letter === "a" ? 1 : letter.charCodeAt(0) - 96) : null };
}
