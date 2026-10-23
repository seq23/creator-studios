"""Studio fix A+B combined (23 Oct 2026): the engine's side of the cross-dependencies, pinned:
  * her one-tap fixes (spec.fixes, keys from shared/fixes.ts) steer Try another version;
  * the fix keys are the Worker's keys exactly;
  * the camera date the Worker read at upload (spec.assets[].taken_at) wins for grouping events.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import clipmaker as CM  # noqa: E402
import plan as P  # noqa: E402
import playbook as PB  # noqa: E402


def part(aid: str, s: float, e: float, stage: str = "process", photo: bool = False) -> P.Part:
    return P.Part(aid, s, e, "after", "", stage, f"{aid}:{s}", photo)


def plan(parts: list[P.Part], ctype: str = "finished_walkthrough") -> P.Plan:
    pl = P.Plan("montage", None, parts)
    pl.clip_type = ctype
    return pl


class Fixes(unittest.TestCase):
    def test_keys_are_the_workers(self) -> None:
        ts = (HERE.parent / "shared" / "fixes.ts").read_text(encoding="utf-8")
        keys = re.findall(r"^\s{2}([a-z_]+): \{ label:", ts, re.M)
        self.assertEqual(tuple(keys), CM.FIX_KEYS)
        self.assertEqual(CM.clean_fixes(["shorter", "nope", "less_blur", "shorter"]), ["less_blur", "shorter"])
        self.assertEqual(CM.clean_fixes(None), [])

    def test_photo_ending_first(self) -> None:
        video_end = plan([part("a", 0, 5), part("b", 0, 3, "hero")])
        photo_end = plan([part("a", 5, 10), part("p", 0, 3, "hero", photo=True)])
        got = CM.apply_fixes([video_end, photo_end], ["photo_ending"], {}, PB.load(None), lambda p: 0.0)
        self.assertIs(got[0], photo_end)
        self.assertTrue(got[0].parts[-1].photo)

    def test_different_opening_moves_away_from_the_version_she_has(self) -> None:
        same = plan([part("a", 0, 5), part("h", 0, 3, "hero")])
        other = plan([part("a", 20, 25), part("h", 0, 3, "hero")])
        overlap = lambda p: 1.0 if p.asset_id == "a" and p.start < 5 else 0.0  # noqa: E731
        self.assertIs(CM.apply_fixes([same, other], ["different_opening"], {}, PB.load(None), overlap)[0], other)

    def test_shorter_cuts_the_middle_and_keeps_the_hero(self) -> None:
        pb = PB.load(None)
        long = plan([part("a", 0, 10), part("b", 0, 10), part("c", 0, 8), part("h", 0, 3, "hero")])
        before = long.length
        got = CM.apply_fixes([long], ["shorter"], {}, pb, lambda p: 0.0)[0]
        self.assertLess(got.length, before)
        self.assertGreaterEqual(got.length, float(PB.template(pb, "finished_walkthrough")["length_s"][0]) - 0.01)
        self.assertEqual(got.parts[-1].stage, "hero")
        self.assertEqual(got.parts[-1].length, 3)

    def test_end_on_finished_prefers_the_longest_held_hero(self) -> None:
        short = plan([part("a", 0, 5), part("h", 0, 2, "hero")])
        held = plan([part("a", 5, 10), part("h", 0, 3.5, "hero")])
        self.assertIs(CM.apply_fixes([short, held], ["end_on_finished"], {}, PB.load(None), lambda p: 0.0)[0], held)

    def test_cut_reads_the_fixes_and_taken_at(self) -> None:
        src = (HERE / "cut.py").read_text(encoding="utf-8")
        self.assertIn('CM.clean_fixes(spec.get("fixes"))', src)
        self.assertIn('a.get("taken_at")', src)


if __name__ == "__main__":
    unittest.main()
