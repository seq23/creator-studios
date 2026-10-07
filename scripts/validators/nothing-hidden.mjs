// Nothing hidden, nothing switched off (owner, 26 Sep 2026: "nothing should be hidden - she can
// use it if she chooses, nothing switched off").
//   1. No screen, nav item, tab, card or button in app/** is conditioned on a features flag. The
//      only place app/ may read `features` is the Settings switches themselves (a <Switch …> line).
//      Shell's NAV list carries no `feature:` gate.
//   2. Every Settings → Features default is ON: DEFAULT_FEATURES in shared/constants.ts, and the
//      last migration that writes the `features` row. No Worker code keeps its own inline
//      features default (it spreads DEFAULT_FEATURES), so the two can never disagree.
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

  // 1. no UI behind a flag
  for (const f of await walk(path.join(root, "app"), [".tsx", ".ts"])) {
    const rel = path.relative(root, f);
    items++;
    const lines = (await readFile(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\bfeature\s*:\s*["']/.test(line)) problems.push(`${rel}:${i + 1}: a nav/tab item gated on a feature flag`);
      if (!/\bfeatures\b\s*(\??\.|\[)/.test(line)) return;
      const settingsSwitch = rel === path.join("app", "pages", "Settings.tsx") && /<Switch\b/.test(line);
      const refreshAfterSave = rel === path.join("app", "pages", "Settings.tsx") && /if \(partial\.features\) await refreshMe\(\)/.test(line);
      if (!settingsSwitch && !refreshAfterSave) problems.push(`${rel}:${i + 1}: UI reads a features flag (only the Settings switches may); show it and let its own empty state explain`);
    });
  }

  // 2. every default ON
  const constants = await readFile(path.join(root, "shared", "constants.ts"), "utf8");
  const def = constants.match(/export const DEFAULT_FEATURES = \{([^}]*)\}/)?.[1];
  items++;
  if (!def) problems.push("shared/constants.ts: DEFAULT_FEATURES not found");
  else {
    const pairs = [...def.matchAll(/(\w+):\s*(true|false)/g)];
    if (pairs.length < 4) problems.push(`shared/constants.ts: DEFAULT_FEATURES lists ${pairs.length} switches, expected at least 4`);
    for (const [, k, v] of pairs) {
      items++;
      if (v !== "true") problems.push(`shared/constants.ts: DEFAULT_FEATURES.${k} is off; every feature defaults on`);
    }
  }

  const migrations = (await readdir(path.join(root, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
  let last = null;
  for (const m of migrations) {
    const text = await readFile(path.join(root, "migrations", m), "utf8");
    const writes = [...text.matchAll(/'features'[^;]*?'(\{[^']*\})'|SET value = '(\{[^']*\})'[^;]*key = 'features'/g)];
    for (const w of writes) last = { file: m, json: w[1] ?? w[2] };
  }
  items++;
  if (!last) problems.push("migrations: no migration writes the features row");
  else {
    const row = JSON.parse(last.json);
    for (const [k, v] of Object.entries(row)) if (v !== true) problems.push(`migrations/${last.file}: features.${k} is written as ${v}; the last write must turn every feature on`);
  }

  for (const f of await walk(path.join(root, "worker"), [".ts"])) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(/getSetting<Features>\([^,]+,\s*"features",\s*([^)]*)\)/g)) {
      items++;
      if (!/DEFAULT_FEATURES/.test(m[1])) problems.push(`${path.relative(root, f)}: keeps its own features default; spread DEFAULT_FEATURES`);
    }
  }
  return { items, problems };
}
