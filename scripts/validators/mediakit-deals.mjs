// Media kit + brand deals (docs/reviews/2026-09-25-mediakit-deals.md). Fails when:
//   1. a kit figure is rendered without its "as of" date and source (app/components/kit/KitSheet.tsx
//      is the only place the public kit renders figures; each figure block must show both, and a
//      self-reported figure must say so), or another kit or deals file renders follower counts without them;
//   2. an email scenario in worker/domain/emails.ts has no template (subjects + body) or no row in
//      the SCENARIO_TESTS table of tests/unit/emails.test.ts;
//   3. a rate benchmark in worker/domain/ratecard.ts has no https source and checked date;
//   4. a marketplace in worker/domain/marketplaces.ts is not in docs/BRAND-SOURCES.md.
// Raw colours and sizes are the design-tokens validator's job (kept green alongside this one).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir, exts) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, exts)));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const read = (p) => readFile(path.join(root, p), "utf8");

  // 1. figures carry as-of + source
  const sheet = await read("app/components/kit/KitSheet.tsx");
  const figBlocks = [...sheet.matchAll(/className="ks-figure"[\s\S]*?<\/div>\s*\n\s*\)\)/g)].map((m) => m[0]);
  if (!figBlocks.length) problems.push("KitSheet.tsx: no ks-figure block found (figures must be rendered there, with as-of and source)");
  for (const b of figBlocks) {
    items++;
    if (!/As of \{asOf\(f\.asOf\)\}/.test(b) || !/\{f\.source\}/.test(b)) problems.push("KitSheet.tsx: a kit figure is rendered without its as-of date and source");
  }
  const manual = sheet.match(/data-self-reported="true"[\s\S]*?<\/div>/)?.[0] ?? "";
  items++;
  if (!/Self-reported, as of \{asOf\(m\.asOf\)\}/.test(manual)) problems.push("KitSheet.tsx: a self-reported figure is rendered without saying so and its date");
  // Kit and deal screens (Stats is her own dashboard, not something a brand sees).
  const kitFiles = [...(await walk(path.join(root, "app", "components", "kit"), [".tsx"])), ...(await walk(path.join(root, "app", "components", "deals"), [".tsx"])), path.join(root, "app", "pages", "MediaKit.tsx"), path.join(root, "app", "pages", "Deals.tsx")];
  for (const f of kitFiles) {
    const text = await readFile(f, "utf8");
    if (!/\bnum\([a-z]+\.followers\)/.test(text)) continue;
    items++;
    if (!/asOf\(/.test(text) || !/\.source\b/.test(text)) problems.push(`${path.relative(root, f)}: renders follower counts without the as-of date and source`);
  }

  // 2. scenarios: a template and a test each
  const emails = await read("worker/domain/emails.ts");
  const tests = await read("tests/unit/emails.test.ts");
  const table = tests.match(/const SCENARIO_TESTS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
  const tested = new Set([...table.matchAll(/^\s*([a-z0-9_]+):/gm)].map((m) => m[1]));
  const block = emails.match(/export const SCENARIOS: Record<ScenarioKey, Scenario> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const keys = [...block.matchAll(/^  ([a-z0-9_]+): \{/gm)].map((m) => m[1]);
  if (!keys.length) problems.push("emails.ts: could not read SCENARIOS");
  for (const k of keys) {
    items++;
    const body = block.slice(block.indexOf(`  ${k}: {`)).split(/\n  [a-z0-9_]+: \{/)[0];
    if (!/subjects: \(f\) =>/.test(body) || !/body: \(f, tone\) =>/.test(body)) problems.push(`emails.ts: scenario ${k} has no template (subjects + body)`);
    if (!tested.has(k)) problems.push(`emails.ts: scenario ${k} has no row in SCENARIO_TESTS (tests/unit/emails.test.ts)`);
  }

  // 3. benchmarks name their source
  const rc = await read("worker/domain/ratecard.ts");
  const sources = [...(rc.match(/export const SOURCES = \{([\s\S]*?)\n\} as const/)?.[1] ?? "").matchAll(/^  ([a-zA-Z0-9]+): \{([^\n]*)\},?$/gm)];
  if (!sources.length) problems.push("ratecard.ts: could not read SOURCES");
  for (const [, name, body] of sources) {
    items++;
    if (!/url: "https:\/\//.test(body) || !/checked: "\d{4}-\d{2}-\d{2}"/.test(body) || !/quote: "/.test(body)) problems.push(`ratecard.ts: source ${name} needs an https url, a checked date and a quote`);
  }

  // 4. marketplaces are the documented ones
  const mk = await read("worker/domain/marketplaces.ts");
  const doc = await read("docs/BRAND-SOURCES.md");
  for (const m of mk.matchAll(/\{ key: "([a-z0-9-]+)"/g)) {
    items++;
    if (!new RegExp(`^\\| ${m[1]} \\|`, "m").test(doc)) problems.push(`marketplaces.ts: ${m[1]} is not in docs/BRAND-SOURCES.md`);
  }
  return { items, problems };
}
