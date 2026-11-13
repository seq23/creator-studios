// "Making your posts, ready about 3 PM" (Home; owner, 13 Nov 2026). An honest guess from how long
// this studio's recent runs took: the middle one, added to when this run started, rounded up to the
// quarter hour. With no history, or once that time has passed, there is no time to give and the
// line says "ready soon" (never a made-up time, never a time in the past).
const QUARTER = 15 * 60_000;
/** A run that "took" under a minute or over a day is a leftover, not a measure. */
const SANE = (ms: number) => Number.isFinite(ms) && ms >= 60_000 && ms <= 24 * 3600_000;

export function readyEstimate(startedAt: string | null, pastRunsMs: number[], now: number): string | null {
  const runs = pastRunsMs.filter(SANE).sort((a, b) => a - b);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!runs.length || !Number.isFinite(started)) return null;
  const at = Math.ceil((started + runs[Math.floor(runs.length / 2)]) / QUARTER) * QUARTER;
  return at > now ? new Date(at).toISOString() : null;
}

/** The one line. `tz` is for tests; on her phone it is her own clock. */
export function makingLine(readyAt: string | null, now = new Date(), tz?: string): string {
  if (!readyAt) return "Making your posts, ready soon";
  const at = new Date(readyAt);
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz });
  const hm = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(":00", "").replace(/\u202f|\u00a0/g, " ");
  const tomorrow = day(new Date(now.getTime() + 86400_000)) === day(at);
  return `Making your posts, ready about ${hm}${day(now) === day(at) ? "" : tomorrow ? " tomorrow" : ` on ${at.toLocaleDateString("en-US", { weekday: "long", timeZone: tz })}`}`;
}
