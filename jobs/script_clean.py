"""Clean words before anyone hears or reads them (owner's studio fix, 23 Oct 2026).

The real failure: a voice over read a model's "thinking" aloud -- "1. **Analyze the Request:**
* **Format:** ..." -- and another said the call to action twice. Every voice-over script, hook and
caption the engine makes or speaks goes through here:
  * reasoning-shaped text (a marker from jobs/script_rules.json, or markdown structure) is REJECTED,
    never tidied into something speakable;
  * markdown signs, asterisks, list numbers, quotes and links are stripped from what is kept;
  * no sentence is said twice, the call to action at most once, and the voice never reads the
    caption back word for word (script, caption and on-screen text tell one story, in different words).
Pure functions, pinned by jobs/tests/test_studio_fix.py. No business words here.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

RULES = json.loads((Path(__file__).resolve().parent / "script_rules.json").read_text(encoding="utf-8"))
MARKERS: list[str] = [m.lower() for m in RULES["reasoning_markers"]]
MD_ANYWHERE = ("**", "__", "##", "```")
MD_LINE_START = tuple(s for s in RULES["markdown_signs"] if s not in MD_ANYWHERE)
URL = re.compile(r"(https?://\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|net|org|co|us|io)(?:/\S*)?)", re.I)


def is_reasoning(text: str) -> bool:
    """True when the text looks like a model working something out rather than words to say."""
    t = (text or "").strip()
    if not t:
        return False
    low = t.lower()
    if any(m in low for m in MARKERS):
        return True
    # A bold field label ("**Hook:** ...", "**Format:**") is a model laying out its answer, not words to say.
    if re.search(r"(\*\*|__)[^*_\n]{1,40}:\s*(\*\*|__)", t):
        return True
    # A paired sign (**bold**) counts once: one emphasised word is markdown, not a plan.
    signs = sum((low.count(s) + 1) // 2 if s in ("**", "__") else low.count(s) for s in MD_ANYWHERE)
    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    signs += sum(1 for ln in lines if ln.startswith(MD_LINE_START) or re.match(r"^\d+[.)]\s", ln))
    # "1. " at the very start of a one-line answer is a numbered plan too.
    if re.match(r"^\s*\d+[.)]\s", t):
        signs += 1
    return signs >= 2


def strip_markdown(text: str) -> str:
    t = re.sub(r"[*_`#>]+", " ", text or "")
    t = re.sub(r"(?m)^\s*(?:[-•]|\d+[.)])\s+", " ", t)
    t = t.replace("“", "").replace("”", "").replace('"', "")
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r"\s+([,.;:!?])", r"\1", t)


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text or "") if s.strip()]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", (s or "").lower()).strip()


def _similar(a: str, b: str) -> bool:
    wa, wb = set(_norm(a).split()), set(_norm(b).split())
    if not wa or not wb:
        return False
    return len(wa & wb) / max(1, min(len(wa), len(wb))) >= 0.8


def clean_line(text: str, limit: int = 300) -> str:
    """A hook or caption body: '' when reasoning-shaped, else the plain words."""
    if is_reasoning(text):
        return ""
    return strip_markdown(text)[:limit]


# What a voice can never say (24 Oct 2026, voice overs on one dump spoke "$350", hashtags run
# together, an emoji, "Made with." and "Book your"): the TypeScript twin is shared/clipWords.ts
# cleanScript (same lists, same order).
SPOKEN_TAGS = re.compile(r"(^|[^\w])[#@]\w+")
SPOKEN_EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF]\uFE0F?(?:\u200D[\U0001F000-\U0001FAFF\u2600-\u27BF]\uFE0F?)*|\uFE0F")
SPOKEN_PRICE = re.compile(r"[$£€]\s?\d|\b\d[\d,.]*\s?(?:dollars|bucks|usd)\b", re.I)
SPOKEN_AI_NOTE = re.compile(r"\bmade with\b", re.I)
LITTLE_WORDS = {"a", "an", "the", "your", "our", "my", "to", "with", "and", "or", "of", "for", "in", "on", "at", "by", "from", "this", "that"}


def _ends(s: str) -> bool:
    return s.endswith((".", "!", "?"))


def cut_words(text: str, max_words: int) -> str:
    """Words cut to max_words, never ending on a little word, ended with a full stop."""
    words = text.split()[:max_words]
    while words and _norm(words[-1]) in LITTLE_WORDS:
        words.pop()
    out = re.sub(r"[,;:\u2014-]+$", "", " ".join(words))
    return f"{out}." if out and not _ends(out) else out


def clean_script(text: str, caption: str = "", ctas: Iterable[str] = (), max_words: int | None = None) -> str:
    """A voice-over script fit to speak, or '' when it must not be spoken (reasoning-shaped or
    nothing left). Links, hashtags, handles and emoji are never read aloud; a sentence with a price
    or the AI note is dropped; a sentence is never said twice; the call to action at most once; a
    sentence that repeats the caption word for word is dropped; an unfinished last fragment goes
    when a finished sentence came before it; a cut keeps whole sentences and never ends on a little word."""
    if is_reasoning(text):
        return ""
    spoken = SPOKEN_EMOJI.sub(". ", SPOKEN_TAGS.sub(r"\1", text or ""))
    plain = URL.sub("", strip_markdown(spoken))
    plain = re.sub(r"^[.\s]+", "", re.sub(r"(?:\.\s*){2,}", ". ", plain))
    cap = [s for s in sentences(strip_markdown(URL.sub("", caption or ""))) if len(_norm(s).split()) >= 4]
    cta_words = [_norm(c) for c in ctas if _norm(c)]
    every = sentences(plain)
    finished = any(_ends(s) for s in every)
    kept: list[str] = []
    said_cta = False
    for i, s in enumerate(every):
        if not _norm(s):
            continue
        if SPOKEN_PRICE.search(s) or SPOKEN_AI_NOTE.search(s):
            continue
        if i == len(every) - 1 and not _ends(s) and finished:
            continue
        if any(_similar(s, k) for k in kept):
            continue
        if any(c and c in _norm(s) for c in cta_words):
            if said_cta:
                continue
            said_cta = True
        elif any(_norm(s) == _norm(c) for c in cap):
            continue
        kept.append(s)
    out = " ".join(kept).strip()
    if max_words and len(out.split()) > max_words:
        fit: list[str] = []
        for s in kept:
            if len(" ".join([*fit, s]).split()) > max_words:
                break
            fit.append(s)
        out = " ".join(fit) if fit else cut_words(out, max_words)
    if out and not _ends(out):
        out = cut_words(out, len(out.split()))
    return out if len(out) >= 6 else ""