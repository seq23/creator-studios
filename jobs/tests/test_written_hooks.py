"""Hooks are written headlines, never lines of speech (owner, 24 Oct 2026), pinned. From a real
re-cut of 19 clips: the moment picker spent the whole free-model budget, so the hook writer and the
critic got no calls; clips without model words took "her own first spoken line" as the hook ("Yeah,
you're good.", "Go ahead.", "Love you, love you, love you Love you, love…", the mis-heard
"Marigold's differing care, thank you very much."), and those clips scored 94-100.
  * a line copied from the transcript is found (clipmaker.echoes_speech) and is never a hook;
  * no model words = no hook from the transcript: the hook writer writes one, else the clip waits;
  * the score judges the words: a copied line or no hook can never score high;
  * the picker always leaves calls for the hook writer and the critic.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import ai as A  # noqa: E402
import clipmaker as CM  # noqa: E402
import cut  # noqa: E402
import playbook as PB  # noqa: E402

SAID = (
    "Hey, hey, oh my god, let me not get hit by a car. Yeah, you're good. Go ahead. I just dropped it. "
    "Love you, love you, love you Love you, love you. Marigold's differing care, thank you very much."
)
REAL_FRAGMENTS = ["Hey, hey, oh my god, let me not get…", "Yeah, you're good.", "Go ahead.", "I just dropped it", "Love you, love you, love you Love you, love…", "Marigold's differing care, thank you very much."]
WRITTEN = ["What I wear on a boat day", "My 5-minute glam before brunch", "Bandana season is officially open", "The skirt that started a conversation", "Sunset deck, zero plans", "How I pack for a sail"]


class Tr:
    def __init__(self, text: str):
        self.text = text

    def text_in(self, s, e):
        return self.text

    def words_in(self, s, e):
        return self.text.split()


class Src:
    def __init__(self, text: str = SAID):
        self.transcript = Tr(text)


def facts(**kw):
    base = {
        "clip_type": "talk_to_camera",
        "parts": [{"stage": "flash", "start": 0, "end": 1.2, "quality": 1}, {"stage": "", "start": 0, "end": 12, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}],
        "hook": "What I wear on a boat day", "caption": "My go-to for a day on the water.", "cta_link": "", "cta_phrases": [],
        "end_card": True, "overlap": 0.0, "repeats": False, "words_pending": False, "said": SAID,
    }
    return {**base, **kw}


class CopiedLinesAreFound(unittest.TestCase):
    def test_every_real_fragment_is_a_copied_line(self):
        for h in REAL_FRAGMENTS:
            self.assertTrue(CM.echoes_speech(h, SAID), h)

    def test_a_written_hook_is_not(self):
        for h in WRITTEN:
            self.assertFalse(CM.echoes_speech(h, SAID), h)
        self.assertFalse(CM.echoes_speech("Good", SAID))  # one shared word is not a copied line


class NoTranscriptHooks(unittest.TestCase):
    def test_fill_copy_never_takes_the_transcript(self):
        m = cut.Moment("a", "talking_head", 0, 10, [(0.0, 10.0)])
        cut.fill_copy(m, Tr(SAID), {"brand_profile": {}}, 0)
        self.assertEqual(m.hook, "")
        self.assertFalse(CM.echoes_speech(m.caption, SAID) if m.caption else False, m.caption)

    def moments(self, hooks):
        return [(cut.Moment("a", "talking_head", 0, 10, [(0.0, 10.0)], hook=h, caption="A real caption about the day." if h else ""), Src()) for h in hooks]

    def test_with_no_model_the_copied_lines_wait_for_words(self):
        moments = self.moments([WRITTEN[0], *REAL_FRAGMENTS, ""])
        stats = cut.distinct_hooks(moments, {"brand_profile": {}}, None, None, PB.load({}))
        self.assertEqual(moments[0][0].hook, WRITTEN[0])
        for m, _ in moments[1:]:
            self.assertTrue(m.words_pending, m.hook)
            self.assertEqual(m.hook, "")
        self.assertEqual(stats["pending"], len(REAL_FRAGMENTS) + 1)
        self.assertNotIn("spoken", stats)

    def test_the_writer_replaces_them_and_its_own_copied_lines_are_refused(self):
        moments = self.moments([WRITTEN[0], *REAL_FRAGMENTS[:3]])

        def answer(key, payload):
            sent = json.loads(payload["messages"][1]["content"])
            self.assertIn("her_voice", sent)
            self.assertIn("never copy a line she says", payload["messages"][0]["content"])
            ns = [c["n"] for c in sent["clips"]]
            # One of them comes back as her speech again: refused.
            return json.dumps({"items": [{"n": ns[0], "hook": WRITTEN[1], "caption": "Glam in five."}, {"n": ns[1], "hook": WRITTEN[2], "caption": "Bandanas out."}, {"n": ns[2], "hook": "Go ahead.", "caption": "Ok."}]})

        with mock.patch.object(cut, "ask_text", answer):
            stats = cut.distinct_hooks(moments, {"brand_profile": {"voice": "Warm, funny"}}, "key", None, PB.load({}))
        self.assertEqual([m.hook for m, _ in moments], [WRITTEN[0], WRITTEN[1], WRITTEN[2], ""])
        self.assertTrue(moments[3][0].words_pending)
        self.assertEqual(stats["rewritten"], 2)
        hooks = [m.hook for m, _ in moments if m.hook]
        self.assertEqual(CM.duplicate_hooks(hooks), [], hooks)
        self.assertFalse(any(CM.echoes_speech(h, SAID) for h in hooks))

    def test_final_words_never_ship_a_copied_line(self):
        m = cut.Moment("a", "talking_head", 0, 10, [(0.0, 10.0)], hook="Go ahead.", caption="A real caption.", hashtags=["#x"])
        m.said = SAID
        rules = CM.studio_rules({"studio_rules": {"cta_phrases": []}}, {})
        w = CM.final_words(m, rules, PB.load({}), 0, False)
        self.assertTrue(w["words_pending"])
        self.assertEqual(w["hook_text"], "")


class TheScoreJudgesTheWords(unittest.TestCase):
    def test_a_copied_line_can_never_score_high(self):
        for h in REAL_FRAGMENTS:
            s, why = CM.score_clip(facts(hook=h), PB.load({}))
            self.assertLessEqual(s, CM.ECHO_CAP, (h, s))
            self.assertIn("The hook is a line from the speech, not a written hook", why)

    def test_no_hook_yet_can_never_score_high(self):
        for kw in ({"hook": "", "words_pending": True}, {"hook": ""}):
            s, why = CM.score_clip(facts(**kw), PB.load({}))
            self.assertLessEqual(s, CM.WORDS_CAP, (kw, s))
        self.assertLess(CM.ECHO_CAP, 70)  # under every studio's bar
        self.assertGreaterEqual(CM.WORDS_CAP, 70)  # a clip waiting for words still shows

    def test_a_written_hook_still_can(self):
        s, why = CM.score_clip(facts(), PB.load({}))
        self.assertEqual(s, 100, why)


class ThePickerLeavesCallsForTheWords(unittest.TestCase):
    def test_the_picker_stops_at_the_reserve_the_writer_does_not(self):
        A.reset()
        calls: list[str] = []

        def ok(key, payload, timeout=150, usable=None):
            calls.append(payload["messages"][0]["content"][:4])
            return ('{"ok": true}', {})

        with mock.patch.object(A, "openrouter_content", ok), mock.patch.object(A, "ask_cloudflare", lambda *a, **k: (None, "")):
            payload = {"model": "m", "messages": [{"role": "system", "content": "pick"}]}
            for _ in range(A.OPENROUTER_JOB_BUDGET):
                cut.or_text("key", payload, 5, reserve=A.WORDS_RESERVE) if A.openrouter_left() > A.WORDS_RESERVE else None
            with self.assertRaises(RuntimeError):
                cut.or_text("key", payload, 5, reserve=A.WORDS_RESERVE)
            self.assertEqual(A.openrouter_left(), A.WORDS_RESERVE)
            self.assertTrue(cut.ask_text("key", {"model": "m", "messages": [{"role": "system", "content": "hook"}]}))
        self.assertGreaterEqual(A.WORDS_RESERVE, 4)
        A.reset()

    def test_the_picker_passes_the_reserve(self):
        src = (HERE / "cut.py").read_text()
        body = src[src.index("def llm_moments("): src.index("def detect_bars(")]
        self.assertIn("reserve=A.WORDS_RESERVE", body)


if __name__ == "__main__":
    unittest.main()
