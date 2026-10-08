#!/usr/bin/env node
// Validator runner. Every validator in scripts/validators/ is registered in the ADMISSION
// REGISTER below with a hard-fail basis. Rule 0: a validator that checks zero items fails.
// Run: npm run validate  (or `node scripts/validate.mjs <name> …` for named validators only,
// e.g. npm run validate:envs; a name not in the register fails)
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ADMISSION REGISTER (collision slot): one line per validator, alphabetical.
// name → why it hard-fails. A validator not listed here is refused; a listed one that is
// missing on disk fails the run.
export const REGISTER = {
  "auto-voice-silent-only": "a voice over laid on a clip where she talks drowns her own words and posts AI audio she never asked for (owner, 26 Sep 2026: clips with speech are never voiced automatically)",
  "bot-prs-get-checks": "a PR opened by a workflow gets no checks, so land can never see it green (help-screenshots PR #21, live test 26 Sep 2026)",
  "design-tokens": "a raw colour, font or off-scale size outside tokens.css is how screens drift apart (docs/design/DESIGN.md)",
  "editors-documented": "a connected editor nobody researched, or a key box for a tool with no API, sends her to a dead end (owner, 25 Sep 2026: only the most popular, honestly)",
  "full-video-uncut": "a full video sent through the cutter or reframed to 9:16 is not the video she made (owner, 26 Sep 2026: the full-video door posts it whole)",
  "help-targets-exist": "a guide step pointing at a label the screen no longer has fails the post-merge screenshot job and reds main (#42, 26 Sep 2026); caught before merge instead",
  "help-guides-exist": "every screen's ? button and every fix_guide slug must open a real guide (section 12c)",
  "help-pictures": "every help step must show its own picture of that step: 20 guides shared one identical picture per step number because the screenshot job fell back to the page heading (owner, 26 Sep 2026: \"the help section has the same screenshot\"); also every screen's help link, tour stop and checklist entry must open a real guide",
  "home-caps": "Home grew with everything a year of use piles up (3.7 phone screens, five year-old follow-ups, no dismiss): every Home list must be capped by HOME_CAPS and proven on a year of data (owner, 26 Sep 2026, day-358 review)",
  "login-never-open": "studio brief §4/§6c: every studio logs in with the email code; an AUTH_MODE \"open\" anywhere, or an \"open\" branch in the login code, makes anyone with the URL the owner",
  "jobs-no-direct-storage": "a job holding storage keys needs an R2 token the owner cannot mint and a public repo can leak; jobs reach storage only through the Worker",
  "jobs-one-openrouter-client": "three hand-rolled OpenRouter clients in jobs each lost the end of a reasoning model's answer (live test 25 Sep 2026); one client in common.py asks again with more room",
  "jobs-registered": "every job type in the schema must have a handler or dispatch silently does nothing",
  "legal-pages": "Google will not publish the Connect YouTube sign-in without a public privacy policy and terms linked from every screen; a path the React app answers shows the login page to Google's reviewers (owner, 26 Sep 2026: full videos straight to her channel)",
  "lists-paged": "on day 358 Review drew 329 video players and Dump and Voice overs cut their lists at 30 without saying so: every long list pages with a true total (owner, 26 Sep 2026)",
  "looks": "a Look without a description, a preview picture or test coverage is an option she picks blind, or one nothing proves renders (owner, 25 Sep 2026: clips must vary)",
  "mediakit-deals": "a kit figure without its as-of date and source tells a brand something unverifiable; an email scenario without a template or a test, a benchmark without a source, or an undocumented marketplace is a made-up claim",
  "no-content-in-logs": "public repo: a console.* outside worker/lib/log.ts can leak her content into Actions logs (section 13)",
  "no-host-brand": "public repo: the host's former business name anywhere (config, code, docs, tests) names a business the studios no longer belong to (owner, 7 Oct 2026: her own domain and sender)",
  "nothing-hidden": "the owner's rule: nothing hidden, nothing switched off; a screen behind a flag, or a feature defaulting off, is a thing she cannot find",
  "no-personal-emails": "public repo: a real person's email address in code, tests or docs is published to everyone; the owner's and the host developer's login emails are deploy-time secrets from 0600 files (owner, 7 Oct 2026: developer login on every studio)",
  "no-secrets": "a key in the repo is public the moment it is pushed",
  "registry-no-emails": "public repo: an owner's email committed in studios/*.json is published to everyone; it is a deploy-time secret from a 0600 file (owner, 7 Oct 2026)",
  "routes-mounted": "a route file nothing mounts is code that exists but nothing invokes",
  "sample-clean": "studio brief §6a: a client studio must carry none of the host's identifiers (emails, names, the former business name, Sheila, the host's channel and account ids) in its config or the shipped bundle, and no host key bound as a secret",
  "screens-registered": "every page file must be routed in App.tsx or it is unreachable",
  "studio-isolation": "studio brief §6b: studio A's D1 or R2 bound by studio B is one client reading another's footage and keys",
  "studios-generated": "the registry is the one list of studios; a hand-edited wrangler.jsonc deploys a studio with another's config",
  "seed-year-local-only": "the year of demo data must never reach staging or production and must be removable row by row",
  "steer-honored": "a chip or a note the cut job never reads is an instruction silently dropped (owner, 26 Sep 2026: on-demand control); every control must be read, mapped, honored and tested",
  "stats-no-login": "the owner's rule (25 Sep 2026): Stats never needs a Google or Meta sign-in; TikTok's zip export was refused as Excel, and a sign-in-only path left the panel blank",
  "tidy-warns-first": "clearing storage must never delete her footage or anything unposted without a warning first, and tidy only archives (owner, 26 Sep 2026: day 358, storage)",
  "voice-engines": "a narration row without its engine, or an ElevenLabs call that drops a 401 / 402 / 429, shows her the wrong voice tag or a failure with no fallback",
  "voice-script": "the read-aloud script must stay about 3 minutes with a question and a number, and the Voice screen must show it, or her sample makes a thin voice",
  "web-research-optional": "the brand finder and the Research Brief must work with no web-research key (Firecrawl is an optional speed-up, owner 26 Sep 2026); a job or route that needs it goes silent without it",
  "workflows-dispatchable": "every job type must have an Actions workflow listening for its repository_dispatch event",
  "youtube-direct": "full videos go straight to her own YouTube channel (owner, 26 Sep 2026): a refresh token in a public repo's job, a deleted video, an upload past YouTube's daily allowance, a Calendar move YouTube never hears about, or a failure shape nobody tested is a video she loses or a light that lies",
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(root, "scripts", "validators");
const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
const onDisk = new Set(files.map((f) => f.replace(/\.mjs$/, "")));
let failed = 0;
let checked = 0;

for (const name of Object.keys(REGISTER).sort()) {
  if (!onDisk.has(name)) {
    console.log(`✗ ${name}: registered but missing on disk`);
    failed++;
    continue;
  }
}
for (const name of onDisk) {
  if (!REGISTER[name]) {
    console.log(`✗ ${name}: on disk but not in the admission register (scripts/validate.mjs)`);
    failed++;
  }
}

const only = process.argv.slice(2);
for (const n of only) {
  if (!REGISTER[n]) {
    console.log(`✗ ${n}: not in the admission register`);
    failed++;
  }
}

for (const file of files) {
  const name = file.replace(/\.mjs$/, "");
  if (!REGISTER[name]) continue;
  if (only.length && !only.includes(name)) continue;
  const mod = await import(pathToFileURL(path.join(dir, file)).href);
  try {
    const r = await mod.default({ root });
    const items = Number(r?.items ?? 0);
    const problems = r?.problems ?? [];
    if (items === 0) {
      console.log(`✗ ${name}: checked 0 items (Rule 0: a validator that checks nothing is inert)`);
      failed++;
      continue;
    }
    checked += items;
    if (problems.length) {
      console.log(`✗ ${name} (${items} items):`);
      for (const p of problems) console.log(`    - ${p}`);
      failed++;
    } else {
      console.log(`✓ ${name} (${items} items)`);
    }
  } catch (e) {
    console.log(`✗ ${name}: threw ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

console.log(`\n${only.length || Object.keys(REGISTER).length} validators, ${checked} items checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
