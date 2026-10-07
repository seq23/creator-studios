// A tiny, safe parser for the help guides (section 12c). Guides are Markdown with a small
// frontmatter; each `## ` heading is one step. No HTML from the file is ever rendered: the
// output is plain data the React page turns into elements.
//
// Frontmatter contract (also in help/index.json "_contract"):
//   title, group, screen, last_checked       required
//   target   CSS or Playwright selector the screenshot job circles (default for every step)
//   fix      slug of the fix-it guide "No, show me a fix" opens (optional)
// Per step, optional HTML comments steer the screenshot job and are never shown:
//   <!-- target: selector -->   circle this element for this step
//   <!-- route: /path -->        open this route for this step (default: the guide's screen)
//   <!-- click: selector -->     click this first (e.g. open a card), then take the shot; several
//                                run in order
//   <!-- fill: selector => text -->  type this into a field before the shot (e.g. a search)
//   <!-- api: METHOD /api/path {json} -->  put the app in the state the step describes through
//                                its own API (e.g. a key refused), before the shot
//   <!-- mock: name -->          a step on another site (Buffer, TikTok Studio, the Instagram app):
//                                a clearly labelled illustration from tests/e2e/help-mocks.ts, never
//                                a screenshot of a real account
//   <!-- light: Name | red | note -->  set one health light for this step (e.g. a red row to fix)
//   <!-- shared -->              this picture is deliberately the same as another step's
// Every step is pictured: a target on the app's screen, a mock frame, or a Look's own picture
// (validator help-pictures; the screenshot job fails a step whose target is not on screen).
// Frontmatter may add `keywords:` (comma-separated words she might search for).

export type Inline = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "code"; v: string } | { t: "link"; v: string; href: string };
export type Block = { kind: "p"; inline: Inline[] } | { kind: "ul" | "ol"; items: Inline[][] };

export interface GuideMeta {
  title: string;
  group: string;
  screen: string | null;
  last_checked: string | null;
  target: string | null;
  fix: string | null;
  keywords: string[];
}

export interface GuideStep {
  title: string;
  image: string | null;
  blocks: Block[];
  target: string | null;
  route: string | null;
  clicks: string[];
  fills: { selector: string; text: string }[];
  api: string[];
  mock: string | null;
  lights: { name: string; light: string; note: string }[];
  shared: boolean;
}

export interface ParsedGuide {
  meta: GuideMeta;
  intro: Block[];
  steps: GuideStep[];
  outro: Block[];
  text: string;
}

const END_HEADINGS = /^(did this work\??|still stuck\??)$/i;

export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\"/g, '"');
    data[kv[1]] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "bold", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else {
      const href = m[4];
      // Only site-relative links, mailto and https: a guide can never inject a script link.
      if (/^(\/|https:\/\/|mailto:)/.test(href)) out.push({ t: "link", v: m[3], href });
      else out.push({ t: "text", v: m[3] });
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: Inline[][] } | null = null;
  const flush = () => {
    if (para.length) out.push({ kind: "p", inline: parseInline(para.join(" ")) });
    para = [];
    if (list) out.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      if (para.length) {
        out.push({ kind: "p", inline: parseInline(para.join(" ")) });
        para = [];
      }
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        if (list) out.push(list);
        list = { kind, items: [] };
      }
      list.items.push(parseInline((ul ?? ol)![1]));
      continue;
    }
    if (list) {
      out.push(list);
      list = null;
    }
    para.push(line);
  }
  flush();
  return out;
}

function directives(lines: string[], name: string): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = new RegExp(`^<!--\\s*${name}:\\s*(.+?)\\s*-->$`).exec(l.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

function directive(lines: string[], name: string): string | null {
  return directives(lines, name)[0] ?? null;
}

export function parseGuide(src: string): ParsedGuide {
  const { data, body } = parseFrontmatter(src);
  const meta: GuideMeta = {
    title: data.title ?? "Guide",
    group: data.group ?? "everyday",
    screen: data.screen || null,
    last_checked: data.last_checked || null,
    target: data.target || null,
    fix: data.fix || null,
    keywords: (data.keywords ?? "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
  };
  const sections: { title: string | null; lines: string[] }[] = [{ title: null, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) sections.push({ title: h[1], lines: [] });
    else if (!/^#\s/.test(line)) sections[sections.length - 1].lines.push(line);
  }
  const intro = blocks(sections[0].lines.filter((l) => !l.trim().startsWith("<!--")));
  const steps: GuideStep[] = [];
  const outro: Block[] = [];
  for (const s of sections.slice(1)) {
    if (END_HEADINGS.test(s.title!)) {
      outro.push(...blocks(s.lines));
      continue;
    }
    let image: string | null = null;
    const rest: string[] = [];
    for (const l of s.lines) {
      const img = /^!\[[^\]]*\]\(([^)\s]+)\)\s*$/.exec(l.trim());
      if (img && !image) image = img[1];
      else if (!l.trim().startsWith("<!--")) rest.push(l);
    }
    steps.push({
      title: s.title!.replace(/^Step\s+\d+[:.]?\s*/i, "") || s.title!,
      image,
      blocks: blocks(rest),
      target: directive(s.lines, "target") ?? meta.target,
      route: directive(s.lines, "route"),
      clicks: directives(s.lines, "click"),
      fills: directives(s.lines, "fill").map((f) => {
        const [selector, ...text] = f.split("=>");
        return { selector: selector.trim(), text: text.join("=>").trim() };
      }),
      api: directives(s.lines, "api"),
      mock: directive(s.lines, "mock"),
      lights: directives(s.lines, "light").map((l) => {
        const [name, light, ...note] = l.split("|").map((x) => x.trim());
        return { name, light, note: note.join("|") };
      }),
      shared: s.lines.some((l) => /^<!--\s*shared\s*-->$/.test(l.trim())),
    });
  }
  const text = [meta.title, ...meta.keywords, ...steps.map((s) => s.title), ...[...intro, ...steps.flatMap((s) => s.blocks)].map(blockText)].join(" ").replace(/\s+/g, " ").toLowerCase();
  return { meta, intro, steps, outro, text };
}

export function blockText(b: Block): string {
  const inl = (xs: Inline[]) => xs.map((x) => x.v).join("");
  return b.kind === "p" ? inl(b.inline) : b.items.map(inl).join(" ");
}

/** Where each guide's `screen` lives in the app (the screenshot job and "Open this screen" use it). */
export const SCREEN_ROUTES: Record<string, string> = {
  home: "/",
  dump: "/dump",
  review: "/review",
  calendar: "/calendar",
  brain: "/brain",
  research: "/research",
  stats: "/stats",
  voice: "/voice",
  settings: "/settings",
  connect: "/settings/connections",
  setup: "/setup",
  deals: "/deals",
  mediakit: "/deals?tab=kit",
  help: "/help",
  login: "/",
};
