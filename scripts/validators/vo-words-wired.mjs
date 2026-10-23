// Follow-on V (owner, 23 Oct 2026): every voice over shows its words on screen, its script follows
// the clip's shots, her notes for the voice reach the script, and with no recording the stock voice
// speaks. Each rule is one wire between files written apart; a rule no longer found is a voice over
// that went silent on screen, a script that reads the caption, or voice overs waiting on a recording.
import { readFile } from "node:fs/promises";
import path from "node:path";

const RULES = [
  ["jobs/voice.py", /words, n_words = words_file\(script, timings, voice_path, clip, work, nid\)\s+subprocess\.run\(mix_command\(clip, voice_path, out, has_audio\(clip\), words\)/, "the batch burns each voice over's words while it mixes"],
  ["jobs/voice.py", /words, n_words = words_file\(str\(spec\.get\("script"\)[^\n]*\n\s+subprocess\.run\(mix_command\(clip, voice, out, with_sound, words\)/, "the single mix burns the voice over's words"],
  ["jobs/voice.py", /seconds, timings = speak\(model, script, voice_path\)/, "the engine's own sentence timings time the words"],
  ["jobs/vo_words.py", /until = words_until\(clip_s\)/, "no word is on screen during the end card"],
  ["worker/jobs/voice.ts", /mode: "mix",[^\n]*script: n\.script \}/, "the single mix gets the script it burns"],
  ["jobs/cut.py", /"shot_list": shot_list\(m, sheets\)/, "the cut sends each clip's timed shot list"],
  ["worker/jobs/cut.ts", /shot_list: \(\(l\) => \(l \? JSON\.stringify\(l\) : null\)\)\(cleanShotList\(c\.shot_list\)\)/, "the Worker keeps the shot list, cleaned"],
  ["worker/lib/autoVoice.ts", /Shots, in order:\\n\$\{shotLines\(shots\)\}/, "the script writer reads the shots in order with their times"],
  ["worker/lib/autoVoice.ts", /Notes for the voice from her[^`]*\$\{notes\}/, "her notes for the voice reach the script writer"],
  ["worker/lib/autoVoice.ts", /return voiceInUse\(await readSound\(env\), await hasVoiceSample\(env\)\)\.stock_voice;/, "with no recording, the stock voice speaks; with one, hers"],
  ["shared/sound.ts", /export const DEFAULT_STOCK_VOICE = "af_heart";/, "the no-recording voice is af_heart"],
  ["app/pages/Dump.tsx", /id="voice-notes"/, "the Dump screen has the notes for the voice box"],
  ["app/components/SoundSettings.tsx", /voiceInUseLine\(inUse\)/, "the Sound screen says which voice is used and why"],
];

export default async function ({ root }) {
  const problems = [];
  for (const [file, re, what] of RULES) {
    const text = await readFile(path.join(root, file), "utf8");
    if (!re.test(text)) problems.push(`${file} no longer does it: ${what}`);
  }
  return { items: RULES.length, problems };
}
