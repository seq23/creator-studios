// The read-aloud script on the Voice screen (app/content/voice-script.md): about 3 minutes at a
// relaxed pace (400 to 520 words), with at least one question and one number so the sample
// covers rising intonation and spoken numbers. And the screen must actually show it.
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MIN_WORDS = 400;
export const MAX_WORDS = 520;
export const HOST_NICHE = /tablescape|tableware|setting a table|table for|charger|linen|dinner part|hosting|keep gathering|candles lit/i;

export default async function ({ root }) {
  const problems = [];
  const file = path.join("app", "content", "voice-script.md");
  const text = await readFile(path.join(root, file), "utf8");
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS || words > MAX_WORDS) problems.push(`${file}: ${words} words; keep it ${MIN_WORDS} to ${MAX_WORDS} (about 3 minutes read aloud)`);
  if (!text.includes("?")) problems.push(`${file}: needs at least one question (a question mark)`);
  if (!/\d/.test(text)) problems.push(`${file}: needs at least one number written in digits`);
  // Every studio reads this script, client studios included: it speaks for any creator, never one
  // creator's niche (found live on sample1, 7 Oct 2026: a table-setting script with a sign-off).
  const niche = HOST_NICHE.exec(text);
  if (niche) problems.push(`${file}: names one creator's niche ("${niche[0]}"); keep the script about making videos, for any creator`);
  const page = await readFile(path.join(root, "app", "pages", "Voice.tsx"), "utf8");
  if (!page.includes("../content/voice-script.md?raw")) problems.push("app/pages/Voice.tsx does not show app/content/voice-script.md");
  return { items: 5, problems };
}
