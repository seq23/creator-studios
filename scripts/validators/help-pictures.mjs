// Help pictures (section 12c; owner, 26 Sep 2026: "the help section has the same screenshot").
// The screenshot job used to circle the page heading whenever a step named no target, so 20
// guides showed one identical picture of the Connect screen per step number. This validator
// reads the committed guides and pictures and fails when a guide could show her the wrong
// picture again:
//   - zero guides (Rule 0)
//   - a step without its own picture: every step has exactly one image, named <slug>-<n>.png for
//     step n (or a Look's own preview /looks/<id>.webp that exists), and its desktop and phone
//     files are committed in help/screenshots
//   - a step the job cannot picture: no target and no mock, or the old "route: external"
//   - a mock name that tests/e2e/help-mocks.ts does not have
//   - two steps whose pictures are byte-identical, unless both say <!-- shared -->
//   - a picture in help/screenshots no step uses
//   - a screen without a "Help for this screen" link, or one pointing at a missing guide
//   - a tour stop that is not in the menu, or whose guide is missing; a Getting started
//     checklist slug or a guide's `fix` that is not a guide
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const END = /^(did this work\??|still stuck\??)$/i;

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const data = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
    if (kv) data[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { data, body: m ? src.slice(m[0].length) : src };
}

/** Steps as the app's parser (app/lib/markdown.ts) sees them: every "## " heading but the closing one. */
function steps(body) {
  const out = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = END.test(h[1]) ? null : { title: h[1], lines: [] };
      if (cur) out.push(cur);
    } else if (cur) cur.lines.push(line.trim());
  }
  return out.map((s) => ({
    title: s.title,
    images: s.lines.map((l) => /^!\[[^\]]*\]\(([^)\s]+)\)$/.exec(l)?.[1]).filter(Boolean),
    target: s.lines.some((l) => /^<!--\s*target:\s*.+-->$/.test(l)),
    mock: s.lines.map((l) => /^<!--\s*mock:\s*(.+?)\s*-->$/.exec(l)?.[1]).find(Boolean) ?? null,
    external: s.lines.some((l) => /^<!--\s*route:\s*external\s*-->$/.test(l)),
    shared: s.lines.some((l) => /^<!--\s*shared\s*-->$/.test(l)),
  }));
}

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const index = JSON.parse(await readFile(path.join(root, "help", "index.json"), "utf8"));
  const guides = index.guides ?? [];
  if (!guides.length) return { items: 0, problems: ["help/index.json lists no guides"] };
  const slugs = new Set(guides.map((g) => g.slug));

  const mocksSrc = await readFile(path.join(root, "tests", "e2e", "help-mocks.ts"), "utf8");
  const mocks = new Set([...mocksSrc.matchAll(/^\s+"([a-z0-9-]+)":\s/gm)].map((m) => m[1]));
  if (!mocks.size) problems.push("tests/e2e/help-mocks.ts: no mock frames found (MOCKS)");

  const shotsDir = path.join(root, "help", "screenshots");
  const onDisk = new Set(existsSync(shotsDir) ? (await readdir(shotsDir)).filter((f) => f.endsWith(".png")) : []);
  const used = new Set();
  const byHash = new Map(); // hash → { where, shared }

  for (const g of guides) {
    const file = path.join(root, "help", "guides", `${g.slug}.md`);
    if (!existsSync(file)) {
      problems.push(`${g.slug}: help/guides/${g.slug}.md is missing`);
      continue;
    }
    const { data, body } = frontmatter(await readFile(file, "utf8"));
    if (data.fix && !slugs.has(data.fix)) problems.push(`${g.slug}: fix '${data.fix}' is not a guide`);
    const list = steps(body);
    if (!list.length) problems.push(`${g.slug}: no steps`);
    for (const [i, s] of list.entries()) {
      items++;
      const n = i + 1;
      const where = `${g.slug} step ${n} ("${s.title}")`;
      if (s.images.length !== 1) {
        problems.push(`${where}: needs exactly one picture, has ${s.images.length}`);
        continue;
      }
      const img = s.images[0];
      const look = /^\/looks\/([a-z_]+)\.webp$/.exec(img);
      if (look) {
        if (!existsSync(path.join(root, "public", "looks", `${look[1]}.webp`))) problems.push(`${where}: ${img} does not exist`);
        continue;
      }
      if (img !== `/help/screenshots/${g.slug}-${n}.png`) problems.push(`${where}: picture must be /help/screenshots/${g.slug}-${n}.png, is ${img}`);
      if (s.external) problems.push(`${where}: 'route: external' is never pictured; use <!-- mock: name --> (tests/e2e/help-mocks.ts)`);
      if (!s.target && !s.mock && !data.target) problems.push(`${where}: no target and no mock, so the job cannot picture this step`);
      if (s.mock && !mocks.has(s.mock)) problems.push(`${where}: mock '${s.mock}' is not in tests/e2e/help-mocks.ts`);
      for (const f of [`${g.slug}-${n}.png`, `${g.slug}-${n}-phone.png`]) {
        used.add(f);
        if (!onDisk.has(f)) {
          problems.push(`${where}: help/screenshots/${f} is missing (run npm run help:screenshots)`);
          continue;
        }
        const hash = createHash("sha256").update(await readFile(path.join(shotsDir, f))).digest("hex");
        const prev = byHash.get(hash);
        if (prev && !(prev.shared && s.shared)) problems.push(`${where}: ${f} is identical to ${prev.where}; each step needs its own picture (or mark both <!-- shared -->)`);
        else if (!prev) byHash.set(hash, { where: `${g.slug} step ${n} (${f})`, shared: s.shared });
      }
    }
  }
  for (const f of onDisk) if (!used.has(f)) problems.push(`help/screenshots/${f} is not used by any guide step`);

  // Every screen's "Help for this screen" link resolves (literal slugs, including both sides of a ternary).
  const pagesDir = path.join(root, "app", "pages");
  const noShell = new Set(["Login.tsx", "MediaKit.tsx"]); // the login card and the public kit page have no ? button
  for (const f of (await readdir(pagesDir)).filter((x) => x.endsWith(".tsx"))) {
    const src = await readFile(path.join(pagesDir, f), "utf8");
    const buttons = [...src.matchAll(/<HelpButton\s+guide=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[1]);
    if (!buttons.length && !noShell.has(f)) problems.push(`app/pages/${f}: no <HelpButton guide=…> ("Help for this screen")`);
    for (const b of buttons) {
      // guide="slug", or the slugs a ternary picks (after ? and :), not the values it compares
      const lits = b.startsWith('"') ? [b.slice(1, -1)] : [...b.matchAll(/[?:]\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
      if (!lits.length) problems.push(`app/pages/${f}: HelpButton guide ${b} names no guide slug`);
      for (const slug of lits) {
        items++;
        if (!slugs.has(slug)) problems.push(`app/pages/${f}: help link '${slug}' is not a guide`);
      }
    }
  }

  // The tour follows the menu; the checklist names real guides.
  const shell = await readFile(path.join(root, "app", "components", "Shell.tsx"), "utf8");
  const nav = new Set([...shell.matchAll(/\{\s*to:\s*"([^"]+)",\s*label:/g)].map((m) => m[1]));
  const tour = await readFile(path.join(root, "app", "components", "Tour.tsx"), "utf8");
  const stops = [...tour.matchAll(/\{\s*to:\s*"([^"]+)",\s*title:\s*"([^"]+)",[^}]*guide:\s*"([a-z0-9-]+)"\s*\}/g)];
  if (!stops.length) problems.push("app/components/Tour.tsx: no tour stops with a guide found");
  for (const [, to, title, guide] of stops) {
    items++;
    if (!nav.has(to)) problems.push(`tour stop "${title}": ${to} is not in the menu (Shell.tsx NAV)`);
    if (!slugs.has(guide)) problems.push(`tour stop "${title}": guide '${guide}' is not a guide`);
  }
  const help = await readFile(path.join(root, "app", "pages", "Help.tsx"), "utf8");
  const checklist = /CHECKLIST\s*=\s*\[([^\]]*)\]/.exec(help)?.[1] ?? "";
  const listed = [...checklist.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  if (!listed.length) problems.push("app/pages/Help.tsx: the Getting started CHECKLIST is empty");
  for (const slug of listed) {
    items++;
    if (!slugs.has(slug)) problems.push(`Getting started checklist: '${slug}' is not a guide`);
  }
  return { items, problems };
}
