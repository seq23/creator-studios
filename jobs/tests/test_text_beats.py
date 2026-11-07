"""On-screen text beats (owner, 7 Nov 2026: Porch & Party clips carry no voice over; the words are on
screen). The hook opens the clip, the beats share the time before the end card, a beat never flashes
for under BEAT_MIN_S, and a 5-second clip still gets its hook in the first 2 seconds plus one beat.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import looks as L  # noqa: E402

OPTS = {"captions": "none", "caption_position": "bottom", "hook": "top_bold"}


class TextBeats(unittest.TestCase):
    def test_short_clip_keeps_hook_in_first_two_seconds_and_one_beat(self) -> None:
        until = 5.0 - L.CARD_SECONDS
        end = L.hook_end(["Book it anyway", "Set up while he's out"], until)
        self.assertLessEqual(end, 2.0)
        self.assertGreaterEqual(end, L.HOOK_MIN_S)
        cues = L.beat_cues(["Book it anyway", "Set up while he's out"], end, until)
        self.assertEqual([c[2] for c in cues], ["Book it anyway"])
        self.assertGreaterEqual(cues[0][1] - cues[0][0], L.BEAT_MIN_S)
        self.assertLessEqual(cues[-1][1], until)

    def test_long_clip_shows_every_beat_in_order_before_the_card(self) -> None:
        beats = ["She thought you forgot", "You booked it from your phone", "We set up and left", "Best birthday you didn't plan"]
        until = 14.3 - L.CARD_SECONDS
        end = L.hook_end(beats, until)
        self.assertEqual(end, L.HOOK_SECONDS)
        cues = L.beat_cues(beats, end, until)
        self.assertEqual([c[2] for c in cues], beats)
        for a, b in zip(cues, cues[1:]):
            self.assertAlmostEqual(a[1], b[0], places=2)
        self.assertLessEqual(cues[-1][1], until + 1e-6)

    def test_burned_text_carries_the_beats_and_none_without_them(self) -> None:
        b = L.Branding()
        with_beats = L.build_ass([], "POV: they think you did all this", OPTS, b, 10.5, True, ["You filled out one form", "You take all the credit"])
        assert with_beats is not None
        self.assertIn("You filled out one form", with_beats)
        self.assertIn("You take all the credit", with_beats)
        without = L.build_ass([], "POV: they think you did all this", OPTS, b, 10.5, True)
        assert without is not None
        self.assertNotIn("You filled out one form", without)
        # Without beats the hook keeps its full time.
        self.assertIn(L.ass_time(L.HOOK_SECONDS), without)

    def test_no_beats_means_nothing_extra(self) -> None:
        self.assertEqual(L.beat_cues([], 2.5, 8.0), [])
        self.assertEqual(L.beat_cues(["  "], 2.5, 8.0), [])


if __name__ == "__main__":
    unittest.main()
