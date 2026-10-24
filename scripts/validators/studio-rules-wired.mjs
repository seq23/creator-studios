// Studio fix (owner's rulings, 23 Oct 2026): the studio's clip rules must reach every cut and every
// post, not merely exist. Fails when:
//   - a studio in the registry has no studioRules, or Porch & Party's link / Made with AI / count /
//     bar drifts from the ruling (the exact phrases and towns are pinned by tests/unit/studio-rules.test.ts);
//   - the cut spec stops carrying studio_rules, niche_playbook, or exif_camera per asset, or sizes the
//     cut to the calendar's need again;
//   - a Buffer path builds post text without the tracking link and the AI note (clipPostText);
//   - the caption's AI note loses its "—" line;
//   - the monthly niche job loses its handler, workflow, daily trigger or its 2-call budget.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const read = (p) => readFile(path.join(root, p), "utf8");
  const slugs = (await readdir(path.join(root, "studios"))).filter((f) => f.endsWith(".json") && f !== "themes.json");
  for (const f of slugs) {
    items++;
    const s = JSON.parse(await read(`studios/${f}`));
    const r = s.studioRules;
    if (!r) problems.push(`studios/${f}: no studioRules (call to action, Made with AI, clips per dump, bar)`);
    else if (!r.clip_target || !Number.isInteger(r.bar)) problems.push(`studios/${f}: studioRules needs clip_target and bar`);
    if (f === "sample1.json" && r && (r.cta_link !== "https://porchandparty901.com/request" || r.ai_note !== "all" || r.bar !== 70 || r.clip_target?.min !== 15 || r.clip_target?.max !== 30 || r.prices !== false))
      problems.push("studios/sample1.json: studioRules no longer matches the owner's ruling (request link, Made with AI on every clip, 15–30 clips, bar 70, no prices)");
  }
  const checks = [
    ["worker/jobs/cut.ts", /studio_rules: rules,/, "the cut spec carries studio_rules"],
    ["worker/jobs/cut.ts", /niche_playbook: await latestPlaybook\(env\),/, "the cut spec carries the niche playbook"],
    ["worker/jobs/cut.ts", /exif_camera: a\.mime_type\.startsWith\("image\/"\) \? a\.exif_camera === 1 : true,/, "each asset carries exif_camera"],
    ["worker/jobs/cut.ts", /target_clips: steerTarget\(dumpCtl, targetClips\(rules\)\)/, "the clip target comes from the studio's setting"],
    ["worker/jobs/cut.ts", /fixes,\n\s*avoid_windows:/, "one-tap fixes reach the again spec"],
    ["worker/crons/buffer-sync.ts", /clipPostText\(env, row, row\.platform\)/, "a loaded post carries the tracking link"],
    ["worker/crons/buffer-sync.ts", /clipPostText\(env, p, p\.platform\)/, "a retried post carries the tracking link"],
    ["shared/postText.ts", /export const AI_NOTE_TAIL = "\\n\\n—\\nMade with AI";/, "the AI note sits after the — line"],
    ["shared/postText.ts", /u\.searchParams\.set\("utm_medium", "social"\);/, "tracking links say utm_medium=social"],
    ["worker/routes/uploads.ts", /await readCamera\(c\.env, c\.req\.param\("id"\)\);/, "the camera EXIF is read at upload"],
    ["worker/jobs/registry.ts", /^\s*niche: nicheJob,$/m, "the niche job has a handler"],
    ["worker/crons/index.ts", /await monthlyNicheRefresh\(env\)/, "the daily lane starts the monthly niche research"],
    [".github/workflows/job-niche.yml", /OPENROUTER_JOB_BUDGET: "2"/, "the niche job spends at most 2 free AI calls"],
    ["jobs/niche_research.py", /A\.ask_openrouter\(/, "the niche job asks through the budgeted ladder"],
    // Clip quality (owner, 23 Oct 2026): the niche research refreshes with the Brand Profile; calls to action are opt-in.
    ["worker/routes/brain.ts", /await monthlyNicheRefresh\(c\.env\)/, "locking the Brand Profile redoes the niche research"],
    ["worker/lib/niche.ts", /profileVersion: profile\?\.version \?\? null/, "the niche research is due when the Brand Profile changed"],
    ["jobs/cut.py", /flashed = sum\(1 for m, _ in moments if payoff_first\(m, pb\)\)/, "every clip shows its payoff in the first 2 seconds"],
    ["jobs/cut.py", /hook_stats = distinct_hooks\(moments, spec, key, text_ok, pb, rules_s\["place_words"\]\)/, "no near-duplicate hooks in one dump"],
    ["jobs/cut.py", /crowded = set\(CM\.crowded_hooks\(hooks, place\)\) - dups/, "no two hooks crowd one opening or word in one dump"],
    ["worker/lib/wordsPass.ts", /hookVarietyProblem\(d\.words\.hook_text, used, rules\.place_words\)/, "the words pass holds new hooks to the variety check"],
    ["jobs/clipmaker.py", /if link or phrases:/, "the score checks a call to action only when the studio chose one"],
    ["shared/studioRules.ts", /cta_phrases: \[\],/, "no studio gets a default call to action"],
  ];
  for (const [file, re, what] of checks) {
    items++;
    let text = "";
    try {
      text = await read(file);
    } catch {
      problems.push(`${file}: missing (${what})`);
      continue;
    }
    if (!re.test(text)) problems.push(`${file}: ${what} — no longer true`);
  }
  return { items, problems };
}
