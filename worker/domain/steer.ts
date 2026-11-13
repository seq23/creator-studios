// Steering a dump: her chips on the Dump screen and her notes (the dump's and each video's), read
// into one set of controls the cut job must honor, and a plain account of anything that cannot be
// followed. Nothing she asks for is dropped silently: it is followed, or the dump says why not.
// Pure and unit-tested (tests/unit/steer.test.ts, fixtures in tests/unit/fixtures/steer-notes.json).
//
// Precedence, per control: a video's own note (for that video's clips) > what she typed for the
// upload > a choice she tapped > surprise (the built-in variety). What she typed wins over a tap
// (owner, 13 Nov 2026), and the clash is said back BEFORE anything is made (Understood.clashes).
import { PLATFORMS, RECIPES, type Platform, type Recipe } from "@shared/constants";
import { CAPTION_CHOICES, CAPTION_LABEL, LENGTHS, MAX_COUNT, PACES, STEER_KEYS, VOICE_CHOICES, VOICE_LABEL, type VoiceChoice, type CaptionChoice, type Length, type NotFollowed, type Pace, type QuickFix, type SteerControls, type SteerKey, type Understood } from "@shared/steer";
import { CAMERA_LABEL, CAMERA_SOUNDS, libraryKey, MUSIC_LIBRARY, type CameraSound } from "@shared/sound";
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
  if (typeof v.camera === "string" && (CAMERA_SOUNDS as readonly string[]).includes(v.camera)) out.camera = v.camera as CameraSound;
  const words = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((w): w is string => typeof w === "string").map((w) => w.trim().slice(0, 60)).filter((w) => w.length >= 2))].slice(0, 8) : []);
  const inc = words(v.include);
  const avo = words(v.avoid);
  if (inc.length) out.include = inc;
  if (avo.length) out.avoid = avo;
  return { controls: out, not_followed: nf };
}

// ---------------------------------------------------------------- reading a note

const NO_SONGS = "you haven't added songs yet (Settings → Editing → My music), so the studio's built-in music was used";

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
  if (/^a couple/.test(s)) return 2;
  if (s === "a few") return 3;
  return /^\d+$/.test(s) ? Number(s) : (w[s] ?? null);
}

const NUM = String.raw`\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|a couple(?: of)?|a few`;
const NOUN = String.raw`clips?|videos?|shorts?|reels?|tiktoks?|posts?`;
// "one 15 second reel", "two short videos", "a couple of posts": the number need not touch the noun,
// and a number of seconds ("30 second clips") or a grid ("2 by 4") is never a count.
const COUNT_RE = new RegExp(String.raw`\b(${NUM})(?!\s*(?:x|×|by)\s*\d)(?!\s*-?\s*(?:s|secs?|seconds?|mins?|minutes?)\b)\s+(?:\d{1,3}[- ]?(?:s|secs?|seconds?)\s+)?(?:(?:more|short|shorter|long|longer|quick|little|good|nice|new|great|fun|funny|pretty|single)\s+){0,2}(?:${NOUN})\b`);
// "not too long" asks for short; it must never be read as "long".
const NOT = String.raw`\b(?:not|nothing|never|isn'?t|aren'?t)\s+(?:too\s+|so\s+|very\s+|that\s+|super\s+|really\s+)?`;

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
  const { c, nf } = readNote(text, tracks);
  const leftover = leftoverOf(text, tracks);
  return { controls: c, said: describe(c, tracks), not_followed: dedupe(nf), by: "rules", leftover, plan: planLine(c, tracks) };
}

// A part of a note that asks for something (rather than describing the day) starts or turns on one of these.
const ASKS = /\b(make|do|give me|i want|i'd like|i would like|can you|could you|please|start with|end with|open with|begin with|finish with|put|add|use|show|more like|less like|like the|same as|turn|change|only|just|no|don'?t|never|without|instead)\b/;

/**
 * The parts of her note that ask for something none of the rules could read, in her own words.
 * Each part (a sentence, or a stretch between commas) is read on its own: one that gives no
 * control, names nothing that can't be done, and still asks for something is left over, and is
 * said back ("I couldn't use this part"). A part that only describes the day is not an ask: the
 * whole note still goes to the writer of the words (jobs/plan.py copy_prompt).
 */
export function leftoverOf(text: string, tracks: readonly Track[]): string[] {
  const out: string[] = [];
  const quoteFree = text.replace(/["“][^"”]*["”]/g, (q) => q.replace(/[,.;!?]/g, " "));
  for (const part of quoteFree.split(/[.;!?\n]+|,|\s+but\s+|\s+and then\s+/)) {
    const p = part.trim();
    if (p.length < 3) continue;
    const r = readNote(p, tracks);
    if (Object.keys(r.c).length || r.nf.length) continue;
    if (ASKS.test(p.toLowerCase().replace(/[’]/g, "'"))) out.push(p.slice(0, 120));
  }
  return [...new Set(out)].slice(0, 6);
}

function readNote(text: string, tracks: readonly Track[]): { c: SteerControls; nf: NotFollowed[] } {
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
      else {
        // No songs of hers at all: the built-in music plays (said); with songs, the Settings choice stands.
        if (!tracks.length) c.music = "any";
        nf.push({ what: `the song "${want}"`, why: tracks.length ? "there is no song by that name in My music, so your other songs were used" : NO_SONGS });
      }
    } else if (/\b(with music|add music|some music|music on|background music|upbeat music|pretty music|nice music|(?:just|only) (?:[a-z]+ )?music|use my music|my songs?)\b/.test(t)) c.music = "any";
  }
  // Quoted words are names (songs, captions she typed), never instructions for the rules below.
  t = t.replace(/["“][^"”]*["”]/g, " ");
  if ((c.music === "any" || c.music?.startsWith("track:")) && !tracks.length) {
    // The built-in music library plays instead: music she asked for is never dropped.
    if (!nf.some((x) => x.why === NO_SONGS)) nf.push({ what: "your songs", why: NO_SONGS });
    c.music = "any";
  }

  // camera sound (shared/sound.ts)
  if (/\b(no camera sound|camera sound off|mute (?:the )?(?:videos?|clips?|camera|sound|audio)|no (?:background|original|video) (?:sound|audio|noise)|(?:without|drop|remove|lose|cut) (?:the )?(?:camera |background |original )?(?:sound|audio|noise)|music only|just (?:[a-z]+ )?music|no (?:talking|speaking|voices?(?![- ]?overs?)))\b/.test(t)) c.camera = "off";
  else if (/\b(keep (?:the |my )?(?:camera |original )?(?:sound|audio)|keep what i (?:say|said)|camera sound on|with (?:the )?(?:camera|original) sound)\b/.test(t)) c.camera = "keep";

  // "not too long", "not too fast": the opposite is meant, and the word itself must not be read below.
  const notLong = new RegExp(`${NOT}(?:long|lengthy)\\b`);
  const notShort = new RegExp(`${NOT}short\\b`);
  const notFast = new RegExp(`${NOT}(?:fast|quick|rushed|hectic)\\b`);
  const notSlow = new RegExp(`${NOT}(?:slow|boring|sleepy)\\b`);
  if (notLong.test(t)) c.length = "short";
  else if (notShort.test(t)) c.length = "medium";
  if (notFast.test(t) || notSlow.test(t)) c.pace = "normal";
  for (const re of [notLong, notShort, notFast, notSlow]) t = t.replace(new RegExp(re.source, "g"), " ");

  // pace
  if (c.pace) {
    /* said by its opposite above */
  } else if (/\b(fast|punchy|quick cuts?|snappy|high[- ]energy|hype|energetic)\b/.test(t)) c.pace = "fast";
  else if (/\b(calm|slow(?:er)?|chill|relaxed|gentle|soft|laid[- ]back)\b/.test(t)) c.pace = "calm";

  // length
  const secs = /\b(\d{1,3})[\s-]*(?:s|sec|secs|seconds?)\b/.exec(t);
  if (c.length) {
    /* said by its opposite above */
  } else if (/\b(short|shorter|quick clips|bite[- ]sized|under 20)\b/.test(t)) c.length = "short";
  else if (/\b(long(?:er)?|full story|whole story|longer clips)\b/.test(t)) c.length = "long";
  else if (secs) {
    const s = Number(secs[1]);
    c.length = s <= 20 ? "short" : s <= 45 ? "medium" : "long";
    if (s > 90) nf.push({ what: `${s}-second clips`, why: "clips are at most 90 seconds, so long ones (45 to 90 s) were made" });
  }

  // how many
  const cnt = COUNT_RE.exec(t);
  if (!cnt && /\b(?:just|only)\s+(?:the\s+)?one\b(?!\s+(?:song|track|thing|look|grid|more thing))/.test(t)) c.count = 1;
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
  if (/\b(no captions?|no subtitles?|without captions?|without subtitles?|no words(?: on (?:the )?screen)?|no text|no writing|without (?:words|text|writing)|captions? off)\b/.test(t)) c.captions = "none";
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
  // Facebook is a fair place to ask for, and the answer is said: video posts don't go there yet.
  if (/\b(facebook|fb)\b/.test(t)) nf.push({ what: "Facebook", why: "video posts go to TikTok, Instagram and YouTube for now, so these will go there" });
  if (c.platforms && !c.platforms.length) {
    nf.push({ what: "those platforms", why: "that would leave no platform, so all three were kept" });
    delete c.platforms;
  }

  // voice over (her cloned voice on the clips with no talking; worker/domain/autoVoice.ts)
  const VO = String.raw`voice[- ]?overs?|narration|narrating`;
  if (new RegExp(String.raw`\b(?:no|without(?: a| any)?|skip(?: the)?|don'?t (?:add|use|want)(?: a| any)?|not? (?:any )?)\s+(?:${VO})\b|\b(?:${VO})\s+off\b|\bno (?:talking|speaking|voices?(?![- ]?overs?))\b`).test(t)) c.voice = "none";
  else if (new RegExp(String.raw`\b(?:i'?ll|let me|i will|i want to)\s+(?:pick|choose|add)\s+(?:the |my )?(?:${VO})\b|\b(?:${VO})\s+(?:in|from) review\b`).test(t)) c.voice = "pick";
  else if (new RegExp(String.raw`\b(?:voice[- ]?over|narrate)\s+(?:the |my |on the |over the )?(?:b[- ]?roll|quiet (?:clips|parts|bits)|montages?|silent (?:clips|parts)|clips with no talking)\b|\b(?:add|with|use)\s+(?:a |my )?(?:${VO})s?\b`).test(t)) c.voice = "quiet";

  // must be in / must be out
  const bare = t0.replace(/["“”]/g, "");
  // "start with the red door photo": it is made sure to be in; which shot comes first can't be chosen yet, and that is said.
  const first = phrasesAfter(bare, /\b(?:start|open|begin|lead)(?:s|ing)?(?: it| them| off)? with\s+/g);
  for (const p of first) nf.push({ what: `starting with "${p}"`, why: "I can make sure it is in, but I can't choose which shot comes first yet" });
  // "one reel of the balloon arch going up": what the post is of must be in it.
  const of = cnt ? phrasesAfter(bare, new RegExp(`${COUNT_RE.source}\\s+(?:of|about|showing)\\s+`, "g")) : [];
  const inc = [...first, ...of, ...phrasesAfter(bare, /\b(?:make sure (?:you |to )?(?:include|use|get|keep|show)|must (?:include|have|show)|definitely (?:use|include)|include|feature)\s+/g)];
  const avo = [...phrasesAfter(t0.replace(/["“”]/g, ""), /\b(?:don'?t use|do not use|don'?t include|do not include|leave out|skip the|avoid|nothing (?:about|with)|no clips? (?:of|about|with)|cut out)\s+/g)];
  const noise = /^(music|captions?|subtitles?|grids?|songs?|the grid|a grid|any grid|my voice|(?:a |any |the )?voice[- ]?overs?|narration)$/;
  const inClean = inc.filter((p) => !noise.test(p) && !LOOK_RULES.some((r) => r.re.test(` ${p} `)));
  const avClean = avo.filter((p) => !noise.test(p) && !LOOK_RULES.some((r) => r.re.test(` ${p} `)) && !/(tiktok|instagram|youtube|insta|shorts)/.test(p));
  if (inClean.length) c.include = [...new Set(inClean)].slice(0, 8);
  if (avClean.length) c.avoid = [...new Set(avClean)].slice(0, 8);

  return { c, nf };
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
  else if (c.music === "any") out.push(tracks.length ? "Music: your songs" : "Music: the studio's built-in music");
  else if (c.music?.startsWith("track:")) out.push(`Music: "${tracks.find((t) => `track:${t.id}` === c.music)?.name ?? "your song"}"`);
  if (c.pace) out.push(`Pace: ${c.pace}`);
  if (c.length) out.push(`Length: ${LENGTHS[c.length].label.toLowerCase()}`);
  if (c.count) out.push(`How many: ${c.count} post${c.count === 1 ? "" : "s"}`);
  if (c.captions) out.push(`Captions: ${CAPTION_LABEL[c.captions].toLowerCase()}`);
  if (c.platforms) out.push(`For: ${c.platforms.map((p) => PLATFORM_NAME[p]).join(", ")}`);
  if (c.voice) out.push(`Voice over: ${c.voice === "pick" ? "none now, you pick in Review" : VOICE_LABEL[c.voice].toLowerCase()}`);
  if (c.camera) out.push(`Camera sound: ${CAMERA_LABEL[c.camera].toLowerCase()}`);
  if (c.include?.length) out.push(`Must include: ${c.include.map((x) => `"${x}"`).join(", ")}`);
  if (c.avoid?.length) out.push(`Leave out: ${c.avoid.map((x) => `"${x}"`).join(", ")}`);
  return out;
}

// ---------------------------------------------------------------- the one line said back

const LENGTH_WORD: Record<Length, string> = { short: "short (under 20 seconds)", medium: "medium (20 to 45 seconds)", long: "long (45 to 90 seconds)" };
const CAPTION_WORD: Record<CaptionChoice, string> = { none: "no words on screen", karaoke: "words that light up as you talk", boxed: "words on a box", clean: "simple words on screen" };

/**
 * "I'll make about 4 posts: short, no words on screen, Instagram only." Always said before
 * anything is made, whatever she wrote (owner, 13 Nov 2026): her number when she gave one, else
 * `about` (the studio's own estimate for this upload).
 */
export function planLine(c: SteerControls, tracks: readonly Track[], about?: number): string {
  const n = c.count ?? about;
  const head = n ? `I'll make ${c.count ? "" : "about "}${n} post${n === 1 ? "" : "s"}` : "I'll make a mix of posts";
  const bits: string[] = [];
  if (c.length) bits.push(LENGTH_WORD[c.length]);
  if (c.pace && c.pace !== "normal") bits.push(c.pace === "fast" ? "quick cuts" : "calm");
  if (c.looks?.length) bits.push(c.looks.length <= 2 || lookNames(c.looks).startsWith("the ") ? lookNames(c.looks) : `${c.looks.length} looks you picked`);
  if (c.music === "none") bits.push("no music");
  else if (c.music === "any") bits.push(tracks.length ? "your songs" : "the studio's music");
  else if (c.music?.startsWith("track:")) bits.push(`"${(tracks.find((t) => `track:${t.id}` === c.music)?.name ?? "your song").replace(/\.[a-z0-9]+$/i, "")}"`);
  if (c.captions) bits.push(CAPTION_WORD[c.captions]);
  if (c.camera === "off") bits.push("no camera sound");
  if (c.voice === "none") bits.push("no voice over");
  if (c.platforms) bits.push(`${c.platforms.map((p) => PLATFORM_NAME[p]).join(" and ")} only`);
  if (c.include?.length) bits.push(`with ${c.include.map((x) => `"${x}"`).join(", ")}`);
  if (c.avoid?.length) bits.push(`leaving out ${c.avoid.map((x) => `"${x}"`).join(", ")}`);
  return `${head}${bits.length ? `: ${bits.join(", ")}` : n && !c.count ? ", a mix of kinds" : ""}.`;
}

/** A one-tap fix under the line said back, applied to what her note was read as. `about` = the count shown now. */
export function quickFix(c: SteerControls, fix: QuickFix, about: number): SteerControls {
  const n = c.count ?? about;
  if (fix === "fewer") return { ...c, count: Math.max(1, n <= 3 ? n - 1 : Math.round(n / 2)) };
  if (fix === "more") return { ...c, count: Math.min(MAX_COUNT, n < 3 ? n + 1 : Math.round(n * 1.5)) };
  if (fix === "one") return { ...c, count: 1 };
  if (fix === "no_words") return { ...c, captions: "none" };
  return { ...c, platforms: ["instagram"] };
}

const KEY_WORD: Record<SteerKey, string> = { looks: "the look", music: "the music", pace: "the pace", length: "how long", count: "how many", captions: "the words on screen", platforms: "where it goes", voice: "the voice over", camera: "the camera sound", include: "what to include", avoid: "what to leave out" };

// ---------------------------------------------------------------- combining

/**
 * The controls an upload (or one of its videos) is made with. Per control: the video's own note,
 * else what she typed for the upload, else a choice she tapped, else surprise. Where her note and
 * a tap disagree her note wins, and `clashes` says so in plain words for the screen, BEFORE the cut.
 */
export function mergeControls(chips: SteerControls, dumpNote: SteerControls, videoNote: SteerControls = {}): { controls: SteerControls; not_followed: NotFollowed[]; clashes: string[] } {
  const out: SteerControls = {};
  const clashes: string[] = [];
  for (const k of STEER_KEYS) {
    const v = videoNote[k] ?? dumpNote[k] ?? chips[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    if (k !== "include" && k !== "avoid" && chips[k] !== undefined && dumpNote[k] !== undefined && JSON.stringify(chips[k]) !== JSON.stringify(dumpNote[k]))
      clashes.push(`You tapped one thing for ${KEY_WORD[k]} and wrote another. I'll go with what you wrote.`);
  }
  if (dumpNote.include || chips.include) out.include = [...new Set([...(chips.include ?? []), ...(dumpNote.include ?? []), ...(videoNote.include ?? [])])].slice(0, 8);
  if (dumpNote.avoid || chips.avoid) out.avoid = [...new Set([...(chips.avoid ?? []), ...(dumpNote.avoid ?? []), ...(videoNote.avoid ?? [])])].slice(0, 8);
  // Nothing here is left for after the cut any more: a clash is said before (clashes), never in dumps.not_followed.
  return { controls: out, not_followed: [], clashes };
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

/** The built-in music, one track per clip in turn (shared/sound.ts MUSIC_LIBRARY, CC0). */
export const LIBRARY_MUSIC: { r2_key: string }[] = MUSIC_LIBRARY.map((t) => ({ r2_key: libraryKey(t.id) }));

/** Her songs for this dump: none, all of them in turn (the built-in music when she has none), or the one she named. */
export function steerMusic(c: SteerControls, tracks: readonly { id: string; r2_key: string }[], settingsList: { r2_key: string }[]): { r2_key: string }[] {
  if (c.music === "none") return [];
  if (c.music === "any") return tracks.length ? tracks.map((t) => ({ r2_key: t.r2_key })) : LIBRARY_MUSIC;
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

// ---------------------------------------------------------------- what was made (no note needed)

/** Kinds of post in her words (jobs/playbook.json clip types), as "1 x" / "2 x". */
const KIND: Record<string, [string, string]> = {
  payoff_first: ["before and after", "before and afters"],
  pov_walk_in: ["walk-in", "walk-ins"],
  set_up_with_me: ["set-up", "set-ups"],
  prep_only: ["getting ready", "getting ready"],
  team_working: ["of the team working", "of the team working"],
  finished_walkthrough: ["walk-through", "walk-throughs"],
  photo_details: ["of close-ups", "of close-ups"],
  moving_photo: ["moving photo", "moving photos"],
  video_to_photo: ["video ending on a photo", "videos ending on a photo"],
  photo_slideshow: ["photo slideshow", "photo slideshows"],
  talk_to_camera: ["of you talking", "of you talking"],
};

/** Why an upload's video is in no post (jobs/cut.py unused_videos). */
export type UnusedWhy = "unsteady" | "short" | "spare";
/** Under this a video is too short to make a reel from (jobs/cut.py TOO_SHORT_S). */
export const TOO_SHORT_S = 8;

/**
 * One plain line on what an upload became, with or without a note: "4 posts: 2 of the team
 * working, 1 set-up, 1 walk-in; 6 videos weren't steady enough." When videos were too short it
 * says what to add. Never a list of looks or settings she didn't ask about.
 */
export function whatWeTried(clips: readonly { clip_type?: string | null }[], unused: readonly { why: UnusedWhy }[] = []): string {
  const parts: string[] = [];
  if (clips.length) {
    const kinds = new Map<string, number>();
    for (const c of clips) kinds.set(c.clip_type && KIND[c.clip_type] ? c.clip_type : "", (kinds.get(c.clip_type && KIND[c.clip_type] ? c.clip_type : "") ?? 0) + 1);
    const named = [...kinds.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KIND[k]![n === 1 ? 0 : 1]}`);
    const other = kinds.get("") ?? 0;
    if (other && named.length) named.push(`${other} more`);
    parts.push(`${clips.length} post${clips.length === 1 ? "" : "s"}${named.length ? `: ${named.join(", ")}` : ""}`);
  }
  const count = (w: UnusedWhy) => unused.filter((u) => u.why === w).length;
  const shaky = count("unsteady");
  const short = count("short");
  if (shaky) parts.push(`${shaky} video${shaky === 1 ? " wasn't" : "s weren't"} steady enough`);
  let line = parts.length ? `${parts.join("; ")}.` : "";
  if (short) line += `${line ? " " : ""}${short === 1 ? "This video is" : `These ${short} videos are`} too short for a reel. Add videos of ${TOO_SHORT_S} seconds or more.`;
  return line;
}

export { LOOKS };
