// Design tokens (docs/design/DESIGN.md): app/styles/tokens.css is the ONLY place in app/ that may
// hold a raw colour, a font name, a raw font size or an off-scale spacing value. Everything else
// reads a token, so the screens stay one product instead of drifting one hex at a time.
//
// In every app/**/*.css other than tokens.css, per declaration:
//   - no colour literal: #hex, rgb()/rgba()/hsl()/hsla()/oklch()/oklab()/lab()/lch()/hwb(),
//     or the named colours white/black/gray/grey
//   - font-family is var(--font-*) (or inherit)
//   - font-size is var(--text-*) (or inherit)
//   - gap / padding* / margin* use var(--space-*) (or another var), 0, auto, a percentage, or a
//     hairline of at most 2px
// In every app/**/*.tsx inline style={{…}}: no fontSize, fontFamily, lineHeight or letterSpacing,
// no colour literal, and spacing (gap, padding*, margin*) only as a var().
// And every var(--name) used anywhere in app/ is defined somewhere in app/ (a typo in a token
// name silently falls back to nothing).
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

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|(?<![\w-])(?:white|black|gr[ae]y)(?![\w-])/;
const SPACING_PROP = /^(?:gap|row-gap|column-gap|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?)$/;
const SPACING_TSX = /^(?:gap|rowGap|columnGap|padding[A-Z]?\w*|margin[A-Z]?\w*)$/;

/** Strip var(...) and env(...) calls (they are tokens), then look for literal lengths. */
function offScaleLengths(value) {
  let v = value;
  // remove nested var()/env() calls, innermost first
  for (let i = 0; i < 6; i++) v = v.replace(/\b(?:var|env)\([^()]*\)/g, " ");
  const bad = [];
  for (const m of v.matchAll(/-?\d*\.?\d+(px|rem|em|vw|vh|dvh|ch|pt)\b/g)) {
    const n = Math.abs(parseFloat(m[0]));
    if (m[1] === "px" && n <= 2) continue; // hairlines
    bad.push(m[0]);
  }
  return bad;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

export default async function ({ root }) {
  const appDir = path.join(root, "app");
  const cssFiles = await walk(appDir, [".css"]);
  const tsxFiles = await walk(appDir, [".tsx", ".ts"]);
  const problems = [];
  let items = 0;
  const defined = new Set();
  const used = [];

  for (const f of cssFiles) {
    const rel = path.relative(root, f);
    const text = await readFile(f, "utf8");
    const noComments = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    for (const m of noComments.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
    for (const m of noComments.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) used.push([m[1], rel, lineOf(noComments, m.index)]);
    if (path.basename(f) === "tokens.css") continue;
    for (const m of noComments.matchAll(/(^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+);/g)) {
      const prop = m[2];
      const value = m[3].trim();
      if (prop.startsWith("--")) continue;
      items++;
      const at = `${rel}:${lineOf(noComments, m.index + m[1].length)}`;
      if (COLOUR.test(value)) problems.push(`${at} ${prop}: ${value} — raw colour; use a colour token from tokens.css`);
      if (prop === "font-family" && !/^(?:var\(--font-[a-z]+\)|inherit)$/.test(value)) problems.push(`${at} font-family: ${value} — use var(--font-display|body|script|mono)`);
      if (prop === "font-size" && !/^(?:var\(--text-[a-z0-9-]+\)|inherit)$/.test(value)) problems.push(`${at} font-size: ${value} — use a var(--text-*) step from the type scale`);
      if (SPACING_PROP.test(prop)) {
        const bad = offScaleLengths(value);
        if (bad.length) problems.push(`${at} ${prop}: ${value} — ${bad.join(", ")} is off the spacing scale; use var(--space-*)`);
      }
    }
  }

  for (const f of tsxFiles) {
    const rel = path.relative(root, f);
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) used.push([m[1], rel, lineOf(text, m.index)]);
    for (const m of text.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      const body = m[1];
      for (const p of body.matchAll(/([a-zA-Z]+)\s*:\s*("[^"]*"|'[^']*'|`[^`]*`|[^,]+)/g)) {
        const key = p[1];
        const value = p[2].trim();
        items++;
        const at = `${rel}:${lineOf(text, m.index)}`;
        if (/^(?:fontSize|fontFamily|lineHeight|letterSpacing|fontWeight)$/.test(key)) problems.push(`${at} inline ${key}: ${value} — type belongs in a CSS class on the type scale`);
        if (COLOUR.test(value)) problems.push(`${at} inline ${key}: ${value} — raw colour; use a class or a colour token`);
        if (SPACING_TSX.test(key) && !/var\(--/.test(value)) problems.push(`${at} inline ${key}: ${value} — spacing belongs in CSS on the var(--space-*) scale`);
      }
    }
  }

  for (const [name, rel, line] of used) {
    items++;
    if (!defined.has(name)) problems.push(`${rel}:${line} var(${name}) is not defined in any app stylesheet`);
  }

  return { items, problems };
}
