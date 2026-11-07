// P&P captions v3 (owner, 7 Nov 2026): "people can see the rose petals and candles and dont need u to
// say it". The words pass refuses a hook, on-screen beat or caption that narrates the picture (fed back
// to the model as the reason), writes 2-4 short on-screen beats, and keeps no voice script while
// Automatic voice overs is off. A re-render burns the beats (worker/jobs/cut.ts parseBeats ->
// jobs/looks.py build_ass; jobs/tests/test_text_beats.py).
import { describe, expect, it } from "vitest";
import { narratesPicture } from "@shared/clipWords";
import { draftWords, parseDraft } from "@worker/lib/wordsPass";
import { parseBeats } from "@worker/jobs/cut";

const RULES = { cta_phrases: ["Check your date", "Tell us your date", "Request a quote"], cta_link: "https://example.com/request", ai_note: "all" as const, place_words: ["Memphis", "Germantown"] };
const SHOT = "A bedroom with a wooden floor and a bed. · A close-up of a gold balloon. · Red rose petals and white candles on a wooden floor.";
const none = () => [] as string[];

describe("never narrate the picture", () => {
  it("refuses the lines she rejected: they name what the viewer already sees", () => {
    expect(narratesPicture("Gold balloons float above rose petals and candlelight.", SHOT).length).toBeGreaterThanOrEqual(2);
    expect(narratesPicture("Gold balloon shines on rose petal path", SHOT).length).toBeGreaterThanOrEqual(2);
    expect(narratesPicture("Rose petals welcome you home", "A floor decorated with rose petals and lights").length).toBeGreaterThanOrEqual(2);
  });
  it("lets through lines that add what the video cannot show: who it is for, the ease, the occasion, the town", () => {
    for (const t of ["POV: they think you did all this", "You filled out one form", "We set up at home or at the hotel in Memphis.", "Her birthday. She has no idea.", "Skip the restaurant this anniversary"]) expect(narratesPicture(t, SHOT), t).toEqual([]);
    expect(narratesPicture("Christmas is 7 weeks out. Your porch?", "A front door decorated with Christmas-themed wreaths and garlands.")).toEqual([]);
  });
  it("no shot list, nothing to compare: never a refusal", () => {
    expect(narratesPicture("Gold balloons and rose petals", null)).toEqual([]);
  });
});

describe("the words pass writes beats and, with voice overs off, no voice", () => {
  const clip = { number: 1, uses_ai_images: true, on_screen: SHOT, seconds: 10.5 };
  const good = { hook: "POV: they think you did all this", beats: ["You filled out one form", "You take all the credit"], caption: "They walk in and think you spent all day on this. You spent five minutes on a form.", hashtags: ["#MemphisDecorator"], voice: "You walk in and it is waiting for you. We set it all up." };

  it("keeps the beats, and the voice script only when voice overs are on", () => {
    const off = draftWords(good, RULES, { ...clip, voiced: false }, none);
    expect(off.why).toBeNull();
    expect(off.words!.text_beats).toEqual(["You filled out one form", "You take all the credit"]);
    expect(off.words!.voice_script).toBeNull();
    const on = draftWords(good, RULES, { ...clip, voiced: true }, none);
    expect(on.words!.voice_script).toBeTruthy();
  });
  it("a hook, beat or caption that narrates the picture is refused with the reason", () => {
    for (const bad of [{ ...good, hook: "Gold balloon shines on rose petal path" }, { ...good, beats: ["Rose petals and candles"] }, { ...good, caption: "Gold balloons float above rose petals and candlelight." }]) {
      const d = draftWords(bad, RULES, clip, none);
      expect(d.words).toBeNull();
      expect(d.why).toMatch(/already on screen/);
    }
  });
  it("a beat over six words is refused", () => {
    expect(draftWords({ ...good, beats: ["This beat has far too many words in it"] }, RULES, clip, none).why).toMatch(/too long/);
  });
  it("beats come through the model's JSON, and only strings reach the renderer", () => {
    expect(parseDraft(JSON.stringify(good))!.beats).toEqual(good.beats);
    expect(parseBeats(JSON.stringify(["One", " ", 2, "Three", "Four", "Five"]))).toEqual(["One", "2", "Three", "Four"]);
    expect(parseBeats("not json")).toEqual([]);
    expect(parseBeats(null)).toEqual([]);
  });
});
