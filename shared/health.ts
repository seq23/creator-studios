// Health lights as the screens show them (section 11). One list for every screen that lists
// them: Home's card and Settings' Health section read the same rows and must fold them the same
// way, or Home shows "buffer" and "Buffer" as two lights (25 Sep 2026).
//
// Rows written by Connect under the bare service name get a plain label, and are hidden when the
// hourly check has written the fuller row for the same thing.
import type { HealthItem } from "./types";

export const SERVICE_NAMES: Record<string, { label: string; supersededBy?: string }> = {
  buffer: { label: "Buffer", supersededBy: "Buffer" },
  resend: { label: "Email (Resend)", supersededBy: "Email (Resend)" },
  github: { label: "Job runner (GitHub)", supersededBy: "Job runner (GitHub)" },
  openrouter: { label: "AI (OpenRouter)" },
  firecrawl: { label: "Web research (Firecrawl)" },
  hunter: { label: "Hunter (brand contacts)" },
  meta: { label: "Instagram stats" },
  google: { label: "YouTube stats" },
  tiktok: { label: "TikTok stats" },
  elevenlabs: { label: "Voice overs · ElevenLabs", supersededBy: "Voice · ElevenLabs" },
  // rows the voice code writes under its own names (kept), shown under the screen's name
  Voice: { label: "Voice overs" },
  "Voice · ElevenLabs": { label: "Voice overs · ElevenLabs" },
  // connected editors (docs/EDITORS.md)
  opusclip: { label: "Editor · Opus Clip" },
  vizard: { label: "Editor · Vizard" },
  klap: { label: "Editor · Klap" },
  submagic: { label: "Editor · Submagic" },
  descript: { label: "Editor · Descript" },
};

export const LIGHT_ORDER: Record<HealthItem["light"], number> = { red: 0, yellow: 1, grey: 2, green: 3 };

export type HealthRow = HealthItem & { label: string };

/** Plain labels, superseded rows dropped, worst light first, then by name. */
export function foldHealth(health: HealthItem[] | null | undefined): HealthRow[] {
  const rows = health ?? [];
  const names = new Set(rows.map((h) => h.name));
  return rows
    .filter((h) => {
      const s = SERVICE_NAMES[h.name];
      return !(s?.supersededBy && s.supersededBy !== h.name && names.has(s.supersededBy));
    })
    .map((h) => ({ ...h, label: SERVICE_NAMES[h.name]?.label ?? h.name }))
    .sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || a.label.localeCompare(b.label));
}
