// An e2e locator by accessible name must not also match a practice clip's words.
// Playwright's getByRole({ name: "Save" }) is a case-insensitive SUBSTRING match. Review's
// "Use the other hook" button carries the alternative hook in its aria-label, and the practice cut
// (worker/jobs/cut.ts FAKE_HOOKS) picks each clip's hook pair from the dump id's hash, so one dump
// in twelve got the alt "Save this for later" and `{ name: "Save" }` hit two buttons: a strict-mode
// failure that came and went with the random dump id (e2e red on main, 30 Oct 2026, run 41019582387).
// Every non-exact string name in tests/e2e must not be a substring of any practice hook text (or
// the hook button's own label). Use `exact: true` (or a stricter regex) where it would be.
// Zero names examined, or zero practice hooks parsed, fails (Rule 0).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  let items = 0;

  const cut = await readFile(path.join(root, "worker/jobs/cut.ts"), "utf8");
  const block = cut.match(/const FAKE_HOOKS: \[string, string\]\[\] = \[([\s\S]*?)\n\];/)?.[1] ?? "";
  const hooks = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (hooks.length < 2) {
    problems.push("worker/jobs/cut.ts: FAKE_HOOKS not found or empty; this validator cannot see the practice hook words");
    return { items: 0, problems };
  }
  const texts = [...hooks, ...hooks.map((h) => `Use the other hook: “${h}”`)].map((t) => t.toLowerCase());

  const dir = path.join(root, "tests/e2e");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const src = await readFile(path.join(dir, f), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/getByRole\(\s*"[a-z]+"\s*,\s*\{([^}]*)\}/g)) {
        const opts = m[1];
        const name = opts.match(/\bname:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
        if (name === undefined || /\bexact:\s*true\b/.test(opts)) continue;
        items++;
        const n = name.toLowerCase();
        const hit = texts.find((t) => t.includes(n));
        if (hit) problems.push(`tests/e2e/${f}:${i + 1}: name "${name}" (substring match) also matches the practice hook text "${hit}"; add exact: true`);
      }
    });
  }
  return { items, problems };
}
