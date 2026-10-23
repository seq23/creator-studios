"""On-screen words for every voice over (Follow-on V, owner 23 Oct 2026): sound-off viewers read what
the voice says. Pure, no ffmpeg here; jobs/voice.py burns the result with libass while it mixes.

Timings come from the voice engine itself: both engines speak one sentence at a time, so each
sentence's start and end are exact. A voice over that arrives ready (the premium engine) has no
timings: they are estimated from the audio's length, shared out by each sentence's characters.
Each sentence is then shown a few words at a time, timed by characters inside the sentence.

Where the words sit, so they never collide with the rest of the clip (jobs/looks.py):
  - the hook: centred at HOOK_Y for the first HOOK_SECONDS. The words band sits wholly below its
    largest box (three lines), so the two never overlap even while both are on screen;
  - the end card (the last CARD_SECONDS of every clip of 4 s or more: the call to action and the
    link, in the same lower part of the frame): no word is shown from the card's first frame on;
  - the camera's own captions (bottom, MarginV 380): the words band ends above them;
  - the platform buttons: inside SAFE, the 1080x1920 safe area.
Guards: jobs/tests/test_vo_words.py (timing, the bands, the end card) and the `vo-words-wired`
validator (the voice job burns these words in both the batch and the single mix).
"""
from __future__ import annotations

import re

from looks import CARD_SECONDS, HOOK_SECONDS, HOOK_SIZE, HOOK_Y, OUT_H, OUT_W, SAFE, ass_text, ass_time

# The words band: white on a dark box, at most two lines, bottom edge at VO_BOTTOM.
VO_SIZE = 70
VO_LINE = 1.25  # line height as a share of the font size
VO_LINES = 2
VO_BOX = 14  # the box's outline around the text
VO_BOTTOM = 1290
# Few enough words that a phrase fits two lines inside the safe width at VO_SIZE.
PHRASE_WORDS = 5
MIN_CUE = 0.3
# A clip this long or longer carries the end card (jobs/looks.py: card = end_card and dur >= 4.0).
CARD_FROM = 4.0
# The hook's largest box: three lines at HOOK_SIZE, plus its 22 px box (jobs/looks.py "Hook" style).
HOOK_LINES = 3
HOOK_BOX = 22
# The camera's own captions at the bottom: MarginV 380, up to two lines of the largest style (92 px).
CAPTION_MARGIN = 380
CAPTION_SIZE = 92

_SENT = re.compile(r"(?<=[.!?])\s+")


def split_sentences(script: str) -> list[str]:
    """The sentences the voice speaks, in order (both engines speak exactly these)."""
    text = re.sub(r"\s+", " ", script or "").strip()
    out = []
    for s in _SENT.split(text):
        s = s.strip()
        if s:
            out.append(s if s.endswith((".", "!", "?")) else s + ".")
    return out


def words_band() -> tuple[float, float]:
    """Top and bottom (px) of the voice-over words, box included."""
    return VO_BOTTOM - VO_LINES * VO_SIZE * VO_LINE - VO_BOX, VO_BOTTOM + VO_BOX


def hook_band() -> tuple[float, float]:
    half = HOOK_LINES * HOOK_SIZE * VO_LINE / 2 + HOOK_BOX
    return HOOK_Y - half, HOOK_Y + half


def caption_band() -> tuple[float, float]:
    bottom = OUT_H - CAPTION_MARGIN
    return bottom - 2 * CAPTION_SIZE * VO_LINE - 5, bottom


def words_until(clip_s: float) -> float:
    """The last moment a word may be on screen: the end card's first frame, or the clip's end."""
    return max(0.0, clip_s - CARD_SECONDS) if clip_s >= CARD_FROM else clip_s


def estimate_timings(script: str, audio_s: float) -> list[tuple[float, float, str]]:
    """No timings from the engine: each sentence gets a share of the audio by its characters."""
    sents = split_sentences(script)
    if not sents or audio_s <= 0:
        return []
    weights = [len(s) + 6 for s in sents]  # +6: the short pause after each sentence
    total = float(sum(weights))
    out, t = [], 0.0
    for s, w in zip(sents, weights):
        d = audio_s * w / total
        out.append((round(t, 3), round(t + d, 3), s))
        t += d
    return out


def phrase_cues(timings: list[tuple[float, float, str]], clip_s: float) -> list[tuple[float, float, str]]:
    """The sentences shown a few words at a time, timed by characters inside each sentence, never
    past the end card's first frame."""
    until = words_until(clip_s)
    cues: list[tuple[float, float, str]] = []
    for start, end, sentence in timings:
        words = sentence.split()
        if not words or end <= start:
            continue
        chunks = [" ".join(words[i : i + PHRASE_WORDS]) for i in range(0, len(words), PHRASE_WORDS)]
        total = float(sum(len(c) + 1 for c in chunks))
        t = start
        for c in chunks:
            d = (end - start) * (len(c) + 1) / total
            s, e = t, min(t + d, until)
            t += d
            if e - s >= MIN_CUE:
                cues.append((round(s, 3), round(e, 3), c))
    return cues


def build_vo_ass(cues: list[tuple[float, float, str]], font: str = "DejaVu Sans") -> str | None:
    """The ASS file that burns the cues in the words band; None when there is nothing to show."""
    if not cues:
        return None
    white, black, box = "&H00FFFFFF", "&H00000000", "&H40000000"
    fmt = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {OUT_W}", f"PlayResY: {OUT_H}", "WrapStyle: 0", "", "[V4+ Styles]", fmt]
    # Bottom-centre aligned (2), boxed (BorderStyle 3), inside the safe area's left and right edges.
    lines.append(f"Style: Vo,{font},{VO_SIZE},{white},{white},{box},{black},-1,0,0,0,100,100,0,0,3,{VO_BOX},0,2,{SAFE['x0']},{OUT_W - SAFE['x1']},{OUT_H - VO_BOTTOM},1")
    lines += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for s, e, text in cues:
        lines.append(f"Dialogue: 1,{ass_time(s)},{ass_time(e)},Vo,,0,0,0,,{ass_text(text)}")
    return "\n".join(lines) + "\n"


__all__ = ["HOOK_SECONDS", "build_vo_ass", "estimate_timings", "phrase_cues", "split_sentences", "words_band", "hook_band", "caption_band", "words_until"]
