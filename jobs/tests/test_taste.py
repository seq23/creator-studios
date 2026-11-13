"""More like this / Less like this (owner, 13 Nov 2026): kinds she asked for more of are made first;
kinds she asked for less of only fill a batch the others leave short. Golden-set footage."""
from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import clipmaker as CM  # noqa: E402
import golden_playbook as G  # noqa: E402
import playbook as PB  # noqa: E402


def plan(slug: str, taste: dict, n: int = 10) -> list:
    looks, tracks, talk = G.looks_for(G.load()[slug]["uploads"])
    return CM.plan_typed(looks, PB.load({"memory": {"taste": taste}}), {"min": 1, "max": n}, None, tracks, talk)


class Taste(unittest.TestCase):
    def test_less_like_this_leaves_that_kind_out_when_others_fill(self) -> None:
        base = Counter(p.clip_type for p in plan("event-decor", {}, 3))
        self.assertIn("moving_photo", plan_types := [p.clip_type for p in plan("event-decor", {}, 10)])
        got = [p.clip_type for p in plan("event-decor", {"less": ["clip:moving_photo"]}, 3)]
        self.assertEqual(len(got), sum(base.values()))
        self.assertNotIn("moving_photo", got, f"less was ignored: {got} (unsteered {plan_types})")

    def test_less_like_this_still_fills_a_short_batch(self) -> None:
        full = plan("event-decor", {}, 10)
        got = plan("event-decor", {"less": ["clip:moving_photo"]}, 10)
        self.assertEqual(len(got), len(full), "a 'less' kind must still fill a batch the others leave short")

    def test_more_like_this_makes_more_of_that_kind(self) -> None:
        before = [p.clip_type for p in plan("event-decor", {}, 3)].count("moving_photo")
        got = [p.clip_type for p in plan("event-decor", {"more": ["clip:moving_photo"]}, 3)]
        self.assertGreater(got.count("moving_photo"), before, got)
        self.assertEqual(got[0], "moving_photo")

    def test_photo_kinds_and_unknown_kinds_do_not_reach_the_clip_planner(self) -> None:
        pb = PB.load({"memory": {"taste": {"more": ["photo:reel", "clip:not_a_type", 7], "less": ["photo:carousel"]}}})
        self.assertEqual((pb["more"], pb["less"]), ([], []))


if __name__ == "__main__":
    unittest.main()
