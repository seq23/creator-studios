// A year in, every long list pages and tells the truth (day 358, docs/reviews/2026-09-26-day-358.md:
// Review drew 329 clips, Dump cut 50 dumps to 30 and Voice overs 44 to 30 without saying so). Each
// list endpoint below must take a page (LIMIT ? OFFSET ?), answer the true `total`, and carry no
// fixed LIMIT that silently cuts the list. The screen must show "Showing N of TOTAL" (MoreRow).
import { readFile } from "node:fs/promises";
import path from "node:path";

const LISTS = [
  { file: "worker/routes/dumps.ts", route: 'dumps.get("/", ', screen: "app/components/DumpHistory.tsx" },
  { file: "worker/routes/clips.ts", route: 'clips.get("/", ', screen: "app/pages/Review.tsx" },
  { file: "worker/routes/posts.ts", route: 'posts.get("/history", ', screen: "app/components/CalendarHistory.tsx" },
  { file: "worker/routes/voice.ts", route: 'voice.get("/", ', screen: "app/pages/Voice.tsx" },
];

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  for (const l of LISTS) {
    items++;
    const src = await readFile(path.join(root, l.file), "utf8");
    const at = src.indexOf(l.route);
    if (at < 0) {
      problems.push(`${l.file}: ${l.route.trim()} not found`);
      continue;
    }
    const next = src.indexOf("\n});", at);
    const body = src.slice(at, next);
    if (!/LIMIT \? OFFSET \?/.test(body)) problems.push(`${l.file} ${l.route.trim()}: no page (LIMIT ? OFFSET ?)`);
    if (!/\btotal\b/.test(body) || !/COUNT\(\*\)/.test(body)) problems.push(`${l.file} ${l.route.trim()}: no true total (COUNT(*))`);
    for (const m of body.matchAll(/LIMIT (\d+)/g)) problems.push(`${l.file} ${l.route.trim()}: a fixed LIMIT ${m[1]} cuts the list without saying so`);
    const screen = await readFile(path.join(root, l.screen), "utf8");
    if (!/<MoreRow\b/.test(screen)) problems.push(`${l.screen}: the list does not say "Showing N of TOTAL" (MoreRow)`);
  }
  return { items, problems };
}
