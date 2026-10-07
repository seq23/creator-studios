// Steering a dump: her chips on the Dump screen and her notes (the dump's and each video's), read
// into one set of controls the cut job must honor, and a plain account of anything that cannot be
// followed. Nothing she asks for is dropped silently: it is followed, or the dump says why not.
// Pure and unit-tested (tests/unit/steer.test.ts, fixtures in tests/unit/fixtures/steer-notes.json).
//
// Precedence, per control: a video's own note (for that video's clips) > a chip she tapped > the
// dump's note > surprise (the built-in variety). A clash is said, never guessed away.
import { PLATFORMS, RECIPES, type Platform, type Recipe } from "@shared/constants";
import { CAPTION_CHOICES, CAPTION_LABEL, LENGTHS, MAX_COUNT, PACES, STEER_KEYS, VOICE_CHOICES, VOICE_LABEL, type VoiceChoice, type CaptionChoice, type Length, type NotFollowed, type Pace, type SteerControls, type Understood } from "@shared/steer";
import { GRIDS, LOOKS, LOOK_IDS, isGridLook, isLookId, lookById, type LookId, type ResolvedLook } from "./looks";

export interface Track {
  id: string;
  name: string;
}

const PLATFORM_NAME: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };

// ---------------------------------------------------------------- cleaning

/** Controls from anywhere (chips, the AI's answer, a stored row) made safe; what cannot be kept is said. */
export function cleanControls(input: unknown, tracks: readonly Track[]): { controls: SteerControls; not_followed: NotFollowed[] } {
  const v = (input ?? {}) as Record<string, unknown>;
  const out: SteerControls = {};
  const nf: NotFollowed[] = [];
  if (Array.isArray(v.looks)) {
    const known = LOOK_IDS.filter((id) => (v.looks as unknown[]).includes(id));
    for (const x of v.looks as unknown[]) if (typeof x === "string" && !isLookId(x)) nf.push({ what: `the look "${x.slice(0, 40)}"`, why: "there is no look by that name, so the looks you picked (or all of them) were used" });
    if (known.length) out.looks = known;
  }
  if (typeof v.music === "string") {
    if (v.music === "none" || v.music === "any") out.music = v.music;
    else if (v.music.startsWith("track:")) {
      const id = v.music.slice(6);
      if (tracks.some((t) => t.id === id)) out.music = `track:${id}`;
      else nf.push({ what: "that song", why: "it is not in My music any more, so no song was used" });
    }
  }
  if (typeof v.pace === "string" && (PACES as readonly string[]).includes(v.pace)) out.pace = v.pace as Pace;
  if (typeof v.length === "string" && v.length in LENGTHS) out.length = v.length as Length;
  const n = Number(v.count);
  if (v.count !== undefined && v.count !== null) {
    if (Number.isInteger(n) && n >= 1 && n <= MAX_COUNT) out.count = n;
    else if (Number.isFinite(n) && n > MAX_COUNT) {
      out.count = MAX_COUNT;
      nf.push({ what: `${Math.round(n)} clips`, why: `a dump makes at most ${MAX_COUNT}, so ${MAX_COUNT} were made` });
    }
  }
  if (typeof v.captions === "string" && (CAPTION_CHOICES as readonly string[]).includes(v.captions)) out.captions = v.captions as CaptionChoice;
  if (Array.isArray(v.platforms)) {
    const p = PLATFORMS.filter((x) => (v.platforms as unknown[]).includes(x));
    if (p.length) out.platforms = p;
  }
  if (typeof v.voice === "string" && (VOICE_CHOICES as readonly string[]).includes(v.voice)) out.voice = v.voice as VoiceChoice;
  const words = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((w): w is string => typeof w === "string").map((w) => w.trim().slice(0, 60)).filter((w) => w.length >= 2))].slice(0, 8) : []);
  const inc = words(v.include);
  const avo = words(v.avoid);
  if (inc.length) out.include = inc;
  if (avo.length) out.avoid = avo;
  return { controls: out, not_followed: nf };
}

// ---------------------------------------------------------------- reading a note

interface LookRule {
  re: RegExp;
  looks: LookId[];
  label: string;
}

const GRID_IDS = LOOK_IDS.filter(isGridLook);
const SINGLE_IDS = LOOK_IDS.filter((id) => !isGridLook(id));

// Most specific first. Each phrase is how a creator says it, not how the code names it.
const LOOK_RULES: LookRule[] = [
  { re: /\b(2\s*(?:x|×|by)\s*4|grids? of (?:8|eight)|eight[- ]?(?:up|grid|box(?:es)?|squares?)|8[- ]?(?:up|grid|box(?:es)?))\b/, looks: ["grid_eight"], label: "Grid of eight (2 by 4)" },
  { re: /\b(2\s*(?:x|×|by)\s*3|3\s*(?:x|×|by)\s*2|grids? of (?:6|six)|six[- ]?(?:up|grid|box(?:es)?)|6[- ]?(?:up|grid))\b/, looks: ["grid_six"], label: "Grid of six (2 by 3)" },
  { re: /\b(2\s*(?:x|×|by)\s*2|grids? of (?:4|four)|four[- ]?(?:up|grid|box(?:es)?|squares?)|4[- ]?(?:up|grid|box(?:es)?)|quad)\b/, looks: ["grid_four"], label: "Grid of four (2 by 2)" },
  { re: /\b(side[- ]by[- ]side|1\s*(?:x|×|by)\s*2|before (?:and|&) after|left and right)\b/, looks: ["side_by_side"], label: "Side by side" },
  { re: /\b(split(?:[- ]screen)?|stacked|top and bottom|2\s*(?:x|×|by)\s*1)\b/, looks: ["split"], label: "Split moment (two stacked)" },
  { re: /\b(hero(?: and| &)? strip|one big(?: and| with)? (?:three|3) small)\b/, looks: ["hero_strip"], label: "Hero and strip" },
  { re: /\b(cinematic|film look|movie look|filmic)\b/, looks: ["cinematic"], label: "Cinematic" },
  { re: /\b(picture[- ]in[- ]picture|pip|reaction(?: inset| window)?)\b/, looks: ["reaction"], label: "Reaction inset" },
  { re: /\b(bold hook|big hook)\b/, looks: ["bold_hook"], label: "Bold hook" },
  { re: /\b(brand card|brand colou?rs?)\b/, looks: ["brand_card"], label: "Brand card" },
  { re: /\b(clean look|plain look|simple look|minimal(?:ist)? look)\b/, looks: ["clean"], label: "Clean" },
  { re: /\b(karaoke look)\b/, looks: ["karaoke"], label: "Karaoke captions" },
  { re: /\b(all grids|only grids|grids only|just grids|multi[- ]?video|collage)\b/, looks: GRID_IDS, label: "the grid looks" },
];

const NO_GRIDS = /\b(no grids?|without grids?|not? (?:a |the )?grids?|skip (?:the )?grids?|single (?:video|shot)s? only)\b/;
const UNKNOWN_GRID = /\b(\d)\s*(?:x|×|by)\s*(\d)\b/g;
const KNOWN_GRIDS = new Set(["2x4", "4x2", "2x3", "3x2", "2x2", "1x2", "2x1"]);

function numberWord(s: string): number | null {
  const w: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
  return /^\d+$/.test(s) ? Number(s) : (w[s] ?? null);
}

/** The phrase after a cue, up to the end of the clause: "don't use the part where I cough" → "the part where I cough". */
function phrasesAfter(text: string, cue: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(cue)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const phrase = rest.split(/[.;,!?\n]| but | and then /)[0].trim().replace(/^(the part (?:where|with|about)|the bit (?:where|with|about)|anything (?:about|with)|any|the)\s+/, "").trim();
    if (phrase.length >= 2 && phrase.split(/\s+/).length <= 8) out.push(phrase);
  }
  return out;
}

/**
 * A note read by rules: the phrases creators use for looks and grids, music, pace, length, how
 * many, captions, platforms, and what must be in or out. Anything that sounds like a request but
 * cannot be met (a 3x3 grid, a song she never uploaded) comes back in not_followed.
 */
export function parseNotes(text: string, tracks: readonly Track[]): Understood {
  const t0 = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  let t = t0;
  const c: SteerControls = {};
  const nf: NotFollowed[] = [];

  // looks
  const picked = new Set<LookId>();
  for (const r of LOOK_RULES) if (r.re.test(t)) r.looks.forEach((l) => picked.add(l));
  for (const m of t.matchAll(UNKNOWN_GRID)) {
    const g = `${m[1]}x${m[2]}`;
    if (!KNOWN_GRIDS.has(g)) nf.push({ what: `a ${m[1]} by ${m[2]} grid`, why: "that grid doesn't exist; the grids are 2 stacked, side by side, 2 by 2, 2 by 3, 2 by 4, and one big with three small" });
  }
  if (NO_GRIDS.test(t)) {
    const singles = picked.size ? [...picked].filter((l) => !isGridLook(l)) : SINGLE_IDS;
    c.looks = singles.length ? singles : SINGLE_IDS;
  } else if (picked.size) c.looks = LOOK_IDS.filter((l) => picked.has(l));

  // music
  if (/\b(no music|without music|no song|no songs|no soundtrack|no background music|voice only|just my voice)\b/.test(t)) c.music = "none";
  else {
    const named = /\b(?:use|with|play|add)\s+(?:my\s+)?(?:song\s+)?["“]?([a-z0-9][a-z0-9 '&-]{1,40}?)["”]?\s+(?:song|track|music)\b/.exec(t) ?? /\b(?:song|track)\s+(?:called\s+)?["“]([^"”]{2,40})["”]/.exec(t);
    if (named) {
      const want = named[1].trim();
      // A song's name is not an instruction: "Chill piano" must not read as "calm".
      t = t.replace(named[0], " ");
      const hit = tracks.find((tr) => tr.name.toLowerCase().includes(want) || want.split(/\s+/).filter((w) => w.length >= 3).some((w) => tr.name.toLowerCase().includes(w)));
      if (hit) c.music = `track:${hit.id}`;
      else if (/^(upbeat|chill|happy|calm|fun|sad|my|a|the|some|any)$/.test(want)) c.music = "any";
      else nf.push({ what: `the song "${want}"`, why: tracks.length ? "there is no song by that name in My music, so your other songs were used" : "you haven't added songs yet (Settings → Editing → My music), so no music was used" });
    } else if (/\b(with music|add music|some music|music on|background music|upbeat music|use my music|my songs?)\b/.test(t)) c.music = "any";
  }
  // Quoted words are names (songs, captions she typed), never instructions for the rules below.
  t = t.replace(/["“][^"”]*["”]/g, " ");
  if ((c.music === "any" || c.music?.startsWith("track:")) && !tracks.length) {
    nf.push({ what: "music", why: "you haven't added songs yet (Settings → Editing → My music), so no music was used" });
    delete c.music;
  }

  // pace
  if (/\b(fast|punchy|quick cuts?|snappy|high[- ]energy|hype|energetic)\b/.test(t)) c.pace = "fast";
  else if (/\b(calm|slow(?:er)?|chill|relaxed|gentle|soft|laid[- ]back)\b/.test(t)) c.pace = "calm";

  // length
  const secs = /\b(\d{1,3})\s*(?:s|sec|secs|seconds?)\b/.exec(t);
  if (/\b(short|shorter|quick clips|bite[- ]sized|under 20)\b/.test(t)) c.length = "short";
  else if (/\b(long(?:er)?|full story|whole story|longer clips)\b/.test(t)) c.length = "long";
  else if (secs) {
    const s = Number(secs[1]);
    c.length = s <= 20 ? "short" : s <= 45 ? "medium" : "long";
    if (s > 90) nf.push({ what: `${s}-second clips`, why: "clips are at most 90 seconds, so long ones (45 to 90 s) were made" });
  }

  // how many
  const cnt = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty)\s+(?:clips?|videos?|shorts?|reels?|tiktoks?|posts?)\b/.exec(t);
  if (cnt) {
    const n = numberWord(cnt[1]);
    if (n) {
      if (n > MAX_COUNT) {
        c.count = MAX_COUNT;
        nf.push({ what: `${n} clips`, why: `a dump makes at most ${MAX_COUNT}, so ${MAX_COUNT} were made` });
      } else if (n >= 1) c.count = n;
    }
  }

  // captions
  if (/\b(no captions?|no subtitles?|without captions?|without subtitles?|no words on screen|captions? off)\b/.test(t)) c.captions = "none";
  else if (/\b(karaoke|word[- ]by[- ]word|highlight(?:ed)? words?)\b/.test(t)) c.captions = "karaoke";
  else if (/\b(boxed captions?|captions? (?:in|on) a box|box captions?)\b/.test(t)) c.captions = "boxed";
  else if (/\b(simple captions?|clean captions?|plain captions?)\b/.test(t)) c.captions = "clean";

  // platforms
  const only = new Set<Platform>();
  for (const [p, re] of [
    ["tiktok", /\b(tiktok|tik tok)\b/],
    ["instagram", /\b(instagram|insta|ig|reels?)\b/],
    ["youtube", /\b(youtube|yt|shorts)\b/],
  ] as [Platform, RegExp][]) {
    const onlyRe = new RegExp(`\\b(?:only|just)\\s+(?:for\\s+)?(?:on\\s+)?${re.source}|${re.source}\\s+only\\b`);
    if (onlyRe.test(t)) only.add(p);
  }
  const skip = new Set<Platform>();
  for (const [p, re] of [
    ["tiktok", /(tiktok|tik tok)/],
    ["instagram", /(instagram|insta|ig|reels?)/],
    ["youtube", /(youtube|yt|shorts)/],
  ] as [Platform, RegExp][]) {
    if (new RegExp(`\\b(?:not? (?:for |on )?|skip |no |except )${re.source}\\b`).test(t)) skip.add(p);
  }
  if (only.size) c.platforms = PLATFORMS.filter((p) => only.has(p) && !skip.has(p));
  else if (skip.size) c.platforms = PLATFORMS.filter((p) => !skip.has(p));
  if (c.platforms && !c.platforms.length) {
    nf.push({ what: "those platforms", why: "that would leave no platform, so all three were kept" });
    delete c.platforms;
  }

  // voice over (her cloned voice on the clips with no talking; worker/domain/autoVoice.ts)
  const VO = String.raw`voice[- ]?overs?|narration|narrating`;
  if (new RegExp(String.raw`\b(?:no|without(?: a| any)?|skip(?: the)?|don'?t (?:add|use|want)(?: a| any)?|not? (?:any )?)\s+(?:${VO})\b|\b(?:${VO})\s+off\b`).test(t)) c.voice = "none";
  else if (new RegExp(String.raw`\b(?:i'?ll|let me|i will|i want to)\s+(?:pick|choose|add)\s+(?:the |my )?(?:${VO})\b|\b(?:${VO})\s+(?:in|from) review\b`).test(t)) c.voice = "pick";
  else if (new RegExp(String.raw`\b(?:voice[- ]?over|narrate)\s+(?:the |my |on the |over the )?(?:b[- ]?roll|quiet (?:clips|parts|bits)|montages?|silent (?:clips|parts)|clips with no talking)\b|\b(?:add|with|use)\s+(?:a |my )?(?:${VO})s?\b`).test(t)) c.voice = "quiet";

  // must be in / must be out
  const inc = [...phrasesAfter(t0.replace(/["“”]/g, ""), /\b(?:make sure (?:you |to )?(?:include|use|get|keep|show)|must (?:include|have|show)|definitely (?:use|include)|include|feature)\s+/g)];
  const avo = [...phrasesAfter(t0.replace(/["“”]/g, ""), /\b(?:don'?t use|do not use|don'?t include|do not include|leave out|skip the|avoid|nothing (?:about|with)|no clips? (?:of|about|with)|cut out)\s+/g)];
  const noise = /^(music|captions?|subtitles?|grids?|songs?|the grid|a grid|any grid|my voice|(?:a |any |the )?voice[- ]?overs?|narration)$/;
  const inClean = inc.filter((p) => !noise.test(p) && !LOOK_RULES.some((r) => r.re.test(` ${p} `)));
  const avClean = avo.filter((p) => !noise.test(p) && !LOOK_RULES.some((r) => r.re.test(` ${p} `)) && !/(tiktok|instagram|youtube|insta|shorts)/.test(p));
  if (inClean.length) c.include = [...new Set(inClean)].slice(0, 8);
  if (avClean.length) c.avoid = [...new Set(avClean)].slice(0, 8);

  return { controls: c, said: describe(c, tracks), not_followed: dedupe(nf), by: "rules" };
}

function dedupe(nf: NotFollowed[]): NotFollowed[] {
  const seen = new Set<string>();
  return nf.filter((x) => (seen.has(x.what) ? false : (seen.add(x.what), true)));
}

// ---------------------------------------------------------------- saying it back

function lookNames(ids: readonly string[]): string {
  if (ids.length === GRID_IDS.length && GRID_IDS.every((g) => ids.includes(g))) return "the grid looks";
  if (ids.length === SINGLE_IDS.length && SINGLE_IDS.every((g) => ids.includes(g))) return "the single-video looks (no grids)";
  return ids.map((id) => lookById(id)?.name ?? id).join(", ");
}

/** One plain sentence per control, as the Dump screen shows it under "Here's what we understood". */
export function describe(c: SteerControls, tracks: readonly Track[]): string[] {
  const out: string[] = [];
  if (c.looks?.length) out.push(`Look: ${lookNames(c.looks)}${c.looks.length === 1 && isGridLook(c.looks[0]) ? ` (${GRIDS[lookById(c.looks[0])!.grid!].cells.length} cells)` : ""}`);
  if (c.music === "none") out.push("Music: none");
  else if (c.music === "any") out.push("Music: your songs");
  else if (c.music?.startsWith("track:")) out.push(`Music: "${tracks.find((t) => `track:${t.id}` === c.music)?.name ?? "your song"}"`);
  if (c.pace) out.push(`Pace: ${c.pace}`);
  if (c.length) out.push(`Clip length: ${LENGTHS[c.length].label.toLowerCase()}`);
  if (c.count) out.push(`How many: ${c.count} clip${c.count === 1 ? "" : "s"}`);
  if (c.captions) out.push(`Captions: ${CAPTION_LABEL[c.captions].toLowerCase()}`);
  if (c.platforms) out.push(`For: ${c.platforms.map((p) => PLATFORM_NAME[p]).join(", ")}`);
  if (c.voice) out.push(`Voice over: ${c.voice === "pick" ? "none now, you pick in Review" : VOICE_LABEL[c.voice].toLowerCase()}`);
  if (c.include?.length) out.push(`Must include: ${c.include.map((x) => `"${x}"`).join(", ")}`);
  if (c.avoid?.length) out.push(`Leave out: ${c.avoid.map((x) => `"${x}"`).join(", ")}`);
  return out;
}

// ---------------------------------------------------------------- combining

/**
 * The controls a dump (or one of its videos) is cut with. Per control: the video's own note, else
 * her chip, else the dump's note, else surprise. A note that disagrees with a chip is said.
 */
export function mergeControls(chips: SteerControls, dumpNote: SteerControls, videoNote: SteerControls = {}): { controls: SteerControls; not_followed: NotFollowed[] } {
  const out: SteerControls = {};
  const nf: NotFollowed[] = [];
  for (const k of STEER_KEYS) {
    const v = videoNote[k] ?? chips[k] ?? dumpNote[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    if (chips[k] !== undefined && dumpNote[k] !== undefined && JSON.stringify(chips[k]) !== JSON.stringify(dumpNote[k]) && videoNote[k] === undefined)
      nf.push({ what: `your note's ${k === "looks" ? "look" : k}`, why: "you also tapped a choice for it; the tapped choice was used" });
  }
  if (dumpNote.include || chips.include) out.include = [...new Set([...(chips.include ?? []), ...(dumpNote.include ?? []), ...(videoNote.include ?? [])])].slice(0, 8);
  if (dumpNote.avoid || chips.avoid) out.avoid = [...new Set([...(chips.avoid ?? []), ...(dumpNote.avoid ?? []), ...(videoNote.avoid ?? [])])].slice(0, 8);
  return { controls: out, not_followed: nf };
}

// ---------------------------------------------------------------- into the cut job's spec

/** A Look as the job renders it, with her captions and pace choices on top. */
export function steerLook(look: ResolvedLook, c: SteerControls): ResolvedLook {
  const out = { ...look };
  if (c.captions) out.captions = c.captions;
  if (c.pace === "fast") {
    out.punch_in = true;
    out.crossfade = false;
  } else if (c.pace === "calm") {
    out.punch_in = false;
    out.crossfade = true;
  }
  if (c.music === "none") out.music = false;
  else if (c.music) out.music = true;
  return out;
}

/** Her songs for this dump: none, all of them in turn, or the one she named. */
export function steerMusic(c: SteerControls, tracks: readonly { id: string; r2_key: string }[], settingsList: { r2_key: string }[]): { r2_key: string }[] {
  if (c.music === "none") return [];
  if (c.music === "any") return tracks.map((t) => ({ r2_key: t.r2_key }));
  if (c.music?.startsWith("track:")) return tracks.filter((t) => `track:${t.id}` === c.music).map((t) => ({ r2_key: t.r2_key }));
  return settingsList;
}

/** Recipe bounds for a chosen clip length: every recipe is squeezed into that range (never beyond its own maximum). */
export function steerRecipes(c: SteerControls): Record<Recipe, { minS: number; maxS: number }> {
  const base = Object.fromEntries(Object.entries(RECIPES).map(([k, v]) => [k, { minS: v.minS, maxS: v.maxS }])) as Record<Recipe, { minS: number; maxS: number }>;
  if (!c.length) return base;
  const L = LENGTHS[c.length];
  for (const k of Object.keys(base) as Recipe[]) {
    const maxS = Math.min(RECIPES[k].maxS, L.maxS);
    const minS = Math.min(Math.max(L.minS, 3), maxS);
    base[k] = { minS, maxS };
  }
  return base;
}

/** The recipes whose own bounds reach the chosen length (a 45–90 s clip is a story, not a talking head). */
export function recipesAllowed(c: SteerControls): Recipe[] {
  const all = Object.keys(RECIPES) as Recipe[];
  if (!c.length) return all;
  const L = LENGTHS[c.length];
  return all.filter((k) => RECIPES[k].maxS >= L.minS + 2);
}

export function steerTarget(c: SteerControls, auto: { min: number; max: number }): { min: number; max: number } {
  return c.count ? { min: c.count, max: c.count } : auto;
}

export function steerPlatforms(allowed: Platform[], c: SteerControls): Platform[] {
  return c.platforms ? allowed.filter((p) => c.platforms!.includes(p)) : allowed;
}

// ---------------------------------------------------------------- what we tried (Surprise me)

/** One line on what a dump's clips ended up as, so "Surprise me" is never a black box. */
export function whatWeTried(clips: readonly { look: string | null; music: string | null; captions?: string | null }[], tracks: readonly { r2_key: string; name: string }[]): string {
  if (!clips.length) return "";
  const looks = new Map<string, number>();
  for (const c of clips) if (c.look) looks.set(c.look, (looks.get(c.look) ?? 0) + 1);
  const grids = clips.filter((c) => isGridLook(c.look)).length;
  const withMusic = clips.filter((c) => c.music);
  const songs = new Set(withMusic.map((c) => tracks.find((t) => t.r2_key === c.music)?.name ?? "a song"));
  const top = [...looks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => lookById(id)?.name ?? id);
  const parts = [`${clips.length} clip${clips.length === 1 ? "" : "s"} in ${looks.size} look${looks.size === 1 ? "" : "s"} (${top.join(", ")}${looks.size > 4 ? ", …" : ""})`];
  parts.push(grids ? `${grids} grid${grids === 1 ? "" : "s"}` : "no grids");
  parts.push(withMusic.length ? `music on ${withMusic.length} (${[...songs].slice(0, 2).join(", ")})` : "no music");
  return `What we tried: ${parts.join(", ")}.`;
}

export { LOOKS };
