// Every help guide step points at something on a screen (<!-- target: … --> the element the
// screenshot circles, <!-- click: … --> / <!-- fill: … --> what it taps first). The screenshot job
// that proves it runs after merge, so a renamed label used to turn main red (26 Sep 2026, #42: the
// switch "Voice overs on clips" became "Automatic voice overs" and two guides still pointed at the
// old words). This checks it before merge, in seconds: every name, text, aria-label, data-
// attribute, class and id a guide's selector names must still exist in the source that draws the
// screen (app/, shared/, the Worker's API words, the demo seed data, the help mocks). Zero
// selectors fails (Rule 0).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir, exts) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, exts)));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const DIRECTIVE = /<!--\s*(target|click|fill):\s*([\s\S]*?)\s*-->/g;
// Quoted words the selector needs on screen: has-text("…"), text-is("…"), [name="…"], [aria-label="…"], [placeholder="…"], text=…
const WORDS = [/:has-text\("([^"]+)"\)/g, /:text-is\("([^"]+)"\)/g, /\[name="([^"]+)"\]/g, /\[aria-label="([^"]+)"\]/g, /\[placeholder="([^"]+)"\]/g, /^text=(.+)$/g];
const ROLES = new Set(["button", "link", "tab", "dialog", "textbox", "checkbox", "radio", "group", "heading", "region", "switch", "combobox", "list", "listitem", "img", "status", "alert", "navigation", "main", "form", "menu", "menuitem", "option", "row", "cell", "table", "tablist", "tabpanel"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Labels built by a template in the source (aria-label={`${def.title} key`}, id={`editor-${cap}`},
 * `More ${label}`): each becomes a pattern; a guide's words match it only when every filled-in
 * part is itself real text in the source ("Editor · Vizard" + " key").
 */
function templates(src) {
  const out = [];
  for (const m of src.matchAll(/`([^`\n]*\$\{[^`\n]*)`/g)) {
    const parts = m[1].split(/\$\{[^}]*\}/);
    if (parts.join("").replace(/\s/g, "").length < 3) continue; // all placeholder: would match anything
    out.push(new RegExp(`^${parts.map(esc).join("(.+?)")}$`));
  }
  return out;
}

/** Whole words as the source writes them, or built from parts that each exist (a template, or "A · B"). */
function found(corpus, words, tpl, depth = 0) {
  if (corpus.includes(words)) return true;
  const alt = [words.replace(/’/g, "'"), words.replace(/'/g, "’")];
  if (alt.some((a) => corpus.includes(a))) return true;
  if (depth >= 2) return false;
  for (const re of tpl) {
    const m = re.exec(words);
    if (m && m.slice(1).every((x) => x && found(corpus, x, tpl, depth + 1))) return true;
  }
  const parts = words.split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((p) => found(corpus, p, tpl, depth + 1));
}

export default async function ({ root }) {
  const problems = [];
  const guideDir = path.join(root, "help", "guides");
  const guides = (await readdir(guideDir)).filter((f) => f.endsWith(".md"));
  const appFiles = await walk(path.join(root, "app"), [".tsx", ".ts"]);
  const app = (await Promise.all(appFiles.map((f) => readFile(f, "utf8")))).join("\n");
  const other = [
    ...(await walk(path.join(root, "shared"), [".ts"])),
    ...(await walk(path.join(root, "worker"), [".ts"])),
    ...(await walk(path.join(root, "tests", "e2e"), [".sql"])),
    path.join(root, "tests", "e2e", "help-mocks.ts"),
    path.join(root, "jobs", "looks.json"),
  ];
  const text = app + "\n" + (await Promise.all(other.map((f) => readFile(f, "utf8").catch(() => "")))).join("\n");
  const tpl = templates(text);
  let items = 0;
  for (const g of guides) {
    const md = await readFile(path.join(guideDir, g), "utf8");
    for (const m of md.matchAll(DIRECTIVE)) {
      const [, kind, sel] = m;
      items++;
      const where = `help/guides/${g} ${kind} '${sel}'`;
      for (const re of WORDS) for (const w of sel.matchAll(re)) if (!found(text, w[1], tpl)) problems.push(`${where}: "${w[1]}" is on no screen (renamed? change the guide with the screen)`);
      const bare = sel.replace(/"[^"]*"/g, '""');
      const role = /(?:^|\s)role=([a-z]+)/.exec(bare)?.[1];
      if (role && !ROLES.has(role)) problems.push(`${where}: role '${role}' is not a role the screenshot job knows`);
      for (const d of bare.matchAll(/\[(data-[a-z0-9-]+)/g)) if (!app.includes(d[1])) problems.push(`${where}: ${d[1]} is on no screen in app/`);
      if (/^(role|text)=/.test(sel.trim())) continue;
      for (const c of bare.matchAll(/(?:^|[\s>+~(,])[a-z0-9]*((?:\.[a-z][a-z0-9_-]*)+)/gi))
        for (const cls of c[1].split(".").filter(Boolean)) if (!new RegExp(`["'\`\\s{]${esc(cls)}(?=["'\`\\s$}])`).test(app)) problems.push(`${where}: class .${cls} is on no screen in app/`);
      for (const id of bare.matchAll(/#([a-z][a-z0-9_-]*)/gi)) if (!app.includes(`id="${id[1]}"`) && !found(text, id[1], tpl)) problems.push(`${where}: #${id[1]} is on no screen in app/`);
    }
  }
  if (!items) problems.push("no guide selectors found (Rule 0: the scan checks nothing)");
  return { items, problems };
}
