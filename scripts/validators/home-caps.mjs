// Home stays one phone screen however much piles up (day 358, docs/reviews/2026-09-26-day-358.md;
// owner, 26 Sep 2026: "cards that are stacking up"). Every Home list:
//   1. is typed HomeSection<…> in shared/types.ts HomeSummary (no bare array can grow unseen),
//   2. has a cap in shared/constants.ts HOME_CAPS,
//   3. is cut by that cap in worker/routes/home.ts (capSection(…, HOME_CAPS.<key>) or a LIMIT bound
//      to HOME_CAPS.<key>),
//   4. is proven on a year of data by tests/unit/day-358.test.ts "Home never exceeds its caps".
// And the e2e spec measures the phone page (tests/e2e/day-358.spec.ts "Home fits one phone screen").
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const read = (p) => readFile(path.join(root, p), "utf8");
  const constants = await read("shared/constants.ts");
  const capsBody = constants.match(/export const HOME_CAPS = \{([^}]*)\}/)?.[1];
  if (!capsBody) return { items: 1, problems: ["shared/constants.ts: HOME_CAPS not found"] };
  const caps = Object.fromEntries([...capsBody.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const types = await read("shared/types.ts");
  const summary = types.match(/export interface HomeSummary \{([\s\S]*?)\n\}/)?.[1];
  if (!summary) return { items: 1, problems: ["shared/types.ts: HomeSummary not found"] };
  const home = await read("worker/routes/home.ts");
  // fields at the top level of HomeSummary (two-space indent)
  for (const m of summary.matchAll(/^ {2}(\w+)\??:\s*([^;\n]+)/gm)) {
    const [, field, type] = m;
    items++;
    const isSection = /^HomeSection</.test(type);
    const isArray = /\[\]\s*$|^Array</.test(type.trim()) || /\}\[\]$/.test(type.trim());
    if (isArray) problems.push(`shared/types.ts HomeSummary.${field}: a bare list on Home can grow without a cap; make it HomeSection<…> with a HOME_CAPS entry`);
    if (!isSection) continue;
    if (!(field in caps)) {
      problems.push(`HomeSummary.${field} is a HomeSection but HOME_CAPS has no "${field}"`);
      continue;
    }
    if (!(caps[field] >= 1 && caps[field] <= 3)) problems.push(`HOME_CAPS.${field} = ${caps[field]}: a Home list shows 1 to 3 items (one phone screen)`);
    const capped = new RegExp(`${field}:\\s*capSection\\([^\\n]*HOME_CAPS\\.${field}\\)`).test(home) || (new RegExp(`\\.bind\\(HOME_CAPS\\.${field}\\)`).test(home) && new RegExp(`${field}:\\s*\\{\\s*items:`).test(home));
    if (!capped) problems.push(`worker/routes/home.ts: "${field}" is not cut by HOME_CAPS.${field} (capSection or a LIMIT bound to it)`);
  }
  for (const key of Object.keys(caps)) {
    items++;
    if (!new RegExp(`^ {2}${key}\\??:\\s*HomeSection<`, "m").test(summary)) problems.push(`HOME_CAPS.${key} has no HomeSection field in HomeSummary`);
  }
  const unit = await read("tests/unit/day-358.test.ts").catch(() => "");
  items++;
  if (!/Home never exceeds its caps/.test(unit) || !/HOME_CAPS/.test(unit)) problems.push('tests/unit/day-358.test.ts: the "Home never exceeds its caps" test (a year of data against HOME_CAPS) is missing');
  const e2e = await read("tests/e2e/day-358.spec.ts").catch(() => "");
  items++;
  if (!/Home fits one phone screen/.test(e2e)) problems.push('tests/e2e/day-358.spec.ts: the "Home fits one phone screen" measurement is missing');
  return { items, problems };
}
