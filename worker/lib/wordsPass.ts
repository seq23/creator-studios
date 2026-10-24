// The words pass (studio fix A+B, 23 Oct 2026). When no AI words came during a cut, the clip engine
// ships NO stock lines: the clip comes back words_pending (no hook, no caption, no voice script) and
// Review holds Approve. This pass, on every hourly run, writes those words with the $0 sources
// (OpenRouter free models, else the studio's share of Cloudflare Workers AI, worker/lib/freeAi.ts),
// holds them to the engine's rules (shared/clipWords.ts reads jobs/script_rules.json; layer 5's
// content rules), composes the caption in the owner's exact layout, and only then clears
// words_pending. A words-pending clip never posts (worker/domain/sourceCheck.ts POSTABLE_CLIP_SQL)
// and is never voiced until its words are in; once they are, the automatic voice over runs.
// A clip still waiting after a day of tries turns the "Clip words" health light red (nothing silent).
// Guards: tests/unit/studio-fix-ab.test.ts.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { log } from "./log";
import { recordEvent, setHealth } from "./db";
import { readStudioRules } from "./studioRules";
import { getConnectionSecret } from "./connections";
import { getLlm } from "../services/openrouter";
import { freeAi } from "./freeAi";
import { lockedProfile } from "../routes/mediakit";
import { contentRules } from "./photoPosts";
import { textProblems } from "@shared/contentRules";
import { normalizeHashtags } from "../jobs/cut";
import { autoVoiceDump } from "./autoVoice";
import { clipTypeLabel, cleanLine, cleanScript, composeCaption, ctaLine, isReasoning, nearDuplicateHook, sendLine, stripCta, wantsAiNote, type WordsRules } from "@shared/clipWords";
import { latestPlaybook } from "./niche";
import { feelLine } from "@shared/videoFeel";

/** Clips per run (each is one free model call at most). */
export const WORDS_PER_RUN = 8;
/**
 * Only clips that can still be posted get words: New and approved. A rejected clip spent five of
 * the eight hourly tries on 24 Oct 2026 while the clips she would see waited; if she restores one,
 * it is New again and gets its words then.
 */
export const WORDS_STATUSES = "('draft', 'approved')";
/** A try at most once every 50 minutes per clip (the hourly lane). */
export const WORDS_RETRY_MS = 50 * 60 * 1000;
/** After this many tries (a day of hourly runs) the health light goes red. */
export const WORDS_RED_AFTER = 24;
/**
 * The score's on-screen-words check (jobs/clipmaker.py score_clip: 10 points, and a clip still
 * waiting for its words is capped at WORDS_CAP there). Once its words are written the clip gets those
 * points back and the reason flips, so a clip is never scored high before it has a hook and never
 * stays docked after (owner, 24 Oct 2026).
 */
export const WORDS_POINTS = 10;
/** On-screen hook limits, as the engine reads them (jobs/clipmaker.py _readable_hook). */
export const HOOK_MAX_WORDS = 8;
export const HOOK_MAX_CHARS = 56;
export const WAITING_REASON = "The words are still being written";
export const WORDS_HIT = "Short, readable on-screen words";

/** The score and reasons once the words are in. Pure. */
export function scoreWithWords(score: number, reasons: string | null): { score: number; score_reasons: string | null } {
  let list: string[] | null = null;
  try {
    const v = JSON.parse(reasons ?? "null");
    list = Array.isArray(v) ? v.map(String) : null;
  } catch {
    list = null;
  }
  if (list && !list.includes(WAITING_REASON)) return { score, score_reasons: reasons };
  const out = list ? [...list.filter((r) => r !== WAITING_REASON), WORDS_HIT] : null;
  return { score: Math.min(100, Math.round(score) + WORDS_POINTS), score_reasons: out ? JSON.stringify(out) : reasons };
}

interface PendingClip {
  id: string;
  dump_id: string;
  number: number | null;
  start_s: number;
  end_s: number;
  clip_type: string | null;
  on_screen: string | null;
  uses_ai_images: number;
  words_tries: number;
  score: number;
  score_reasons: string | null;
}

export interface DraftWords {
  hook: string;
  caption: string;
  hashtags: string[] | string;
  voice: string;
}

/**
 * The model's answer made into the clip's words, or null when it must not ship: reasoning-shaped
 * or empty hook/caption, or words that break the studio's content rules. Pure.
 */
export function finishWords(
  draft: Partial<DraftWords> | null,
  rules: WordsRules,
  clip: { number: number | null; uses_ai_images: boolean },
  problems: (text: string) => string[],
): { hook_text: string; caption: string; hashtags: string; voice_script: string | null } | null {
  if (!draft) return null;
  const rawHook = String(draft.hook ?? "");
  const rawBody = String(draft.caption ?? "");
  if (isReasoning(rawHook) || isReasoning(rawBody)) return null;
  const hook = cleanLine(rawHook, 120);
  let body = cleanLine(rawBody, 400);
  if (!hook || !body) return null;
  // Short enough to read on screen (jobs/clipmaker.py _readable_hook: 8 words, 56 characters).
  if (hook.split(/\s+/).length > HOOK_MAX_WORDS || hook.length > HOOK_MAX_CHARS) return null;
  const k = Math.max(0, (clip.number ?? 1) - 1);
  body = sendLine(k, stripCta(body, rules) || body);
  const tags = normalizeHashtags(draft.hashtags).split(" ").filter(Boolean).slice(0, 5);
  const caption = composeCaption(body, ctaLine(rules, k), tags, wantsAiNote(rules, clip.uses_ai_images));
  if ([hook, caption].some((t) => problems(t).length > 0)) return null;
  const voice = cleanScript(String(draft.voice ?? ""), caption, rules.cta_phrases);
  return { hook_text: hook, caption, hashtags: tags.join(" "), voice_script: voice || null };
}

/** The largest {...} in a model answer, parsed; null when there is none. */
export function parseDraft(text: string): Partial<DraftWords> | null {
  const m = (text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    return { hook: String(v.hook ?? ""), caption: String(v.caption ?? ""), hashtags: (v.hashtags as string[] | string) ?? [], voice: String(v.voice ?? "") };
  } catch {
    return null;
  }
}

async function askModel(env: Env, system: string, user: string): Promise<string | null> {
  if (await getConnectionSecret(env, "openrouter")) {
    const llm = await getLlm(env);
    const r = await llm.complete({ system, user, json: true, maxTokens: 600, accept: (t) => !!parseDraft(t) });
    if (r.ok && parseDraft(r.text)) return r.text;
  }
  // The studio's share of the free Cloudflare model (never raised, never paid).
  const f = await freeAi(env, [{ role: "system", content: system }, { role: "user", content: user }], 600);
  return f.ok ? f.content : null;
}

/** Practice mode: plain words that say what kind of clip it is (never a stock line from the engine). */
export function practiceDraft(c: Pick<PendingClip, "number" | "clip_type">): DraftWords {
  const kind = clipTypeLabel(c.clip_type) ?? "This clip";
  return { hook: `${kind}, start to finish`, caption: `${kind}: watch it come together, clip ${c.number ?? 1}.`, hashtags: ["#behindthescenes"], voice: `Here is how it came together.` };
}

/** One hourly run. Returns how many clips got their words, how many still wait, and how many are past a day. */
export async function wordsPass(env: Env, now = new Date()): Promise<{ written: number; waiting: number; stuck: number }> {
  const since = new Date(now.getTime() - WORDS_RETRY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, dump_id, number, start_s, end_s, clip_type, on_screen, uses_ai_images, words_tries, score, score_reasons FROM clips
     WHERE words_pending = 1 AND status IN ${WORDS_STATUSES} AND (words_tried_at IS NULL OR words_tried_at < ?) ORDER BY created_at LIMIT ?`,
  )
    .bind(since, WORDS_PER_RUN)
    .all<PendingClip>();
  let written = 0;
  const dumps = new Set<string>();
  if (results.length) {
    const rules = await readStudioRules(env);
    const profile = await lockedProfile(env);
    const cr = contentRules(env);
    const niche = await latestPlaybook(env).catch(() => null);
    const patterns = (niche?.hooks ?? []).slice(0, 6);
    const system =
      `You write the words for one short vertical video clip for a small business. Reply with ONE JSON object only: ` +
      `{"hook": "at most 8 words, shown big on screen", "caption": "one or two plain sentences", "hashtags": ["3 to 5 tags"], "voice": "a short spoken voice-over, plain sentences"}. ` +
      `Write in their voice: ${profile?.voice || "warm and direct"}.${feelLine(profile)} Never mention: ${profile?.off_limits || "nothing listed"}. ` +
      `The hook is a written headline that opens on the payoff (what the viewer gets), never a generic slogan, never a line someone says in the video, and different from every hook already used, and never opening the same way as one of them (not every hook a "POV:").` +
      (patterns.length ? ` Hooks that work in this niche, as patterns only (never word for word): ${patterns.join(" | ")}.` : "") +
      (niche?.caption_style ? ` Captions in this niche read: ${niche.caption_style}.` : "") + ` ` +
      `No call to action in the caption (it is added after), no links, no prices${rules.prices ? " unless real" : ""}, no names or addresses, ` +
      `never mention automation, software or how the video was made. No lists, no markdown, no notes about the task.` +
      (rules.place_words.length ? ` Use one of these local words naturally: ${rules.place_words.join(", ")}.` : "");
    for (const c of results) {
      // The other hooks in this dump (written ones, any status but deleted): never a repeat.
      const { results: others } = await env.DB.prepare("SELECT hook_text FROM clips WHERE dump_id = ? AND id != ? AND status != 'deleted' AND hook_text != ''")
        .bind(c.dump_id, c.id)
        .all<{ hook_text: string }>();
      const used = others.map((o) => o.hook_text);
      const user = `Kind of clip: ${clipTypeLabel(c.clip_type) ?? "a short clip"}. Length: ${Math.round(c.end_s - c.start_s)} seconds.${c.on_screen ? ` On screen, in order: ${c.on_screen}` : ""}${used.length ? `\nHooks already used (write a different one): ${used.slice(0, 30).join(" | ")}` : ""}`;
      const text = fakeServices(env) ? JSON.stringify(practiceDraft(c)) : await askModel(env, system, user);
      const drafted = finishWords(text ? parseDraft(text) : null, rules, { number: c.number, uses_ai_images: !!c.uses_ai_images }, (t) => textProblems(t, cr));
      // Practice mode's labelled stand-in names the clip type, so it is exempt from the repeat check.
      const words = drafted && (fakeServices(env) || !used.some((u) => nearDuplicateHook(drafted.hook_text, u))) ? drafted : null;
      if (!words) {
        await env.DB.prepare("UPDATE clips SET words_tries = words_tries + 1, words_tried_at = ? WHERE id = ?").bind(now.toISOString(), c.id).run();
        continue;
      }
      const scored = scoreWithWords(c.score, c.score_reasons);
      await env.DB.prepare(
        "UPDATE clips SET hook_text = ?, caption = ?, hashtags = ?, voice_script = ?, score = ?, score_reasons = ?, words_pending = 0, words_tries = words_tries + 1, words_tried_at = ? WHERE id = ? AND words_pending = 1",
      )
        .bind(words.hook_text, words.caption, words.hashtags, words.voice_script, scored.score, scored.score_reasons, now.toISOString(), c.id)
        .run();
      written++;
      dumps.add(c.dump_id);
    }
  }
  // Words in: the automatic voice over now voices those clips (it skips clips already voiced).
  for (const d of dumps) await autoVoiceDump(env, d).catch(() => log.warn("words.voice_failed"));
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN words_tries >= ? THEN 1 ELSE 0 END) AS stuck FROM clips WHERE words_pending = 1 AND status IN ${WORDS_STATUSES}`)
    .bind(WORDS_RED_AFTER)
    .first<{ n: number; stuck: number | null }>();
  const waiting = Number(left?.n ?? 0);
  const stuck = Number(left?.stuck ?? 0);
  if (written) await recordEvent(env.DB, "clip.words_written", null, { clips: written });
  await setHealth(
    env.DB,
    "Clip words",
    stuck ? "red" : "green",
    stuck
      ? `${stuck} clip${stuck === 1 ? "" : "s"} still ${stuck === 1 ? "has" : "have"} no words after a day of tries (the free AI did not answer). They stay off the calendar; tap Try another version in Review to cut them again.`
      : `OK · ${written} written this run, ${waiting} waiting`,
    stuck ? "review-and-approve-clips" : null,
  );
  log.info("words.pass", { written, waiting, stuck });
  return { written, waiting, stuck };
}
