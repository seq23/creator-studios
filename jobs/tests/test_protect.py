"""Studio intelligence layer 5 (owner's plan, 22 Oct 2026): PROTECT.

Pinned: the never-list, addresses and made-up prices are refused (the neutral line is used);
customer faces and house numbers are found and blurred only while on screen; the owner's own face
shows only when her rules allow it and the sheet says she is the one working or talking; a strict
studio whose finder cannot run fails closed.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "jobs"))

import plan as P  # noqa: E402
import protect as PR  # noqa: E402
import see as V  # noqa: E402

RULES = {"banWords": ["insured"], "blockAddresses": True, "blockFaces": True, "prices": [{"name": "Big one", "usd": 1050}], "ownerFace": "show"}


class TextTest(unittest.TestCase):
    def test_rules(self):
        r = PR.rules_from({"content_rules": RULES})
        self.assertEqual(PR.text_problems("Fully insured and ready", r), ["ban_word"])
        self.assertEqual(PR.text_problems("Done at 1234 Oak Hollow Cv", r), ["address"])
        self.assertEqual(PR.text_problems("Only $350 today", r), ["price"])  # not on the price list
        self.assertEqual(PR.text_problems("The big one, $1,050", r), [])
        self.assertEqual(PR.text_problems("Book your date", r), [])

    def test_no_price_list_means_profile_prices_only(self):
        none = PR.rules_from({})
        self.assertFalse(none.any)
        self.assertEqual(PR.text_problems("From $250", none, "boards from $250"), [])
        self.assertEqual(PR.text_problems("Only $99", none, "boards from $250"), ["price"])  # made up

    def test_malformed_rules_fail_closed(self):
        r = PR.rules_from({"content_rules": "garbage"})
        self.assertTrue(r.block_faces and r.block_addresses and r.owner_face == "blur")

    def test_model_line_breaking_a_rule_takes_the_neutral_line(self):
        r = PR.rules_from({"content_rules": RULES})
        pl = P.Plan("montage", "alpha work", [P.Part("a", 0, 4, "after", "a finished corner")])
        P.apply_copy([pl], {"items": [{"n": 0, "hook": "Insured and done", "hook_alt": "Only $99", "caption": "Visit 12 Main St"}]}, {}, ["alpha work"], PR.guard(r, {}))
        for t in (pl.hook, pl.hook_alt, pl.caption):
            self.assertEqual(PR.text_problems(t, r), [], t)
        self.assertNotIn("insured", pl.hook.lower())


class PictureTest(unittest.TestCase):
    def sheet(self, people, privacy=()):
        return V.ShotSheet("a", 4.0, [V.Shot(0, 4, people=people, privacy=list(privacy), state="after", confidence=0.9)], "vision:x")

    def run_regions(self, rules, sheet, faces, numbers):
        old = PR._frame
        PR._frame = lambda video, t, out: object()
        try:
            return PR.privacy_regions(Path("v.mp4"), 4.0, rules, sheet, Path("/tmp/protect-test"), (lambda img: list(faces), lambda img: list(numbers)))
        finally:
            PR._frame = old

    def test_customer_faces_and_house_numbers_blurred_while_on_screen(self):
        r = PR.rules_from({"content_rules": RULES})
        regions, ok = self.run_regions(r, self.sheet("others", ["face"]), [(10, 10, 60, 60)], [((200, 200, 260, 230), "1234"), ((300, 300, 340, 330), "21")])
        self.assertTrue(ok)
        boxes = {b for _a, _b, b in regions}
        self.assertIn((10, 10, 60, 60), boxes)
        self.assertIn((200, 200, 260, 230), boxes)
        self.assertNotIn((300, 300, 340, 330), boxes)  # a two-digit number in a shot with no sign flagged (a party number) stays
        self.assertTrue(all(0 <= a < b <= 4.0 for a, b, _ in regions))

    def test_flagged_sign_blurs_any_digits(self):
        r = PR.rules_from({"content_rules": RULES})
        regions, _ = self.run_regions(r, self.sheet("none", ["house_number"]), [], [((300, 300, 340, 330), "21")])
        self.assertTrue(regions)

    def test_owner_face_shows_only_when_allowed(self):
        shown = PR.rules_from({"content_rules": RULES})
        self.assertEqual(self.run_regions(shown, self.sheet("to_camera"), [(10, 10, 60, 60)], [])[0], [])
        blur = PR.rules_from({"content_rules": {**RULES, "ownerFace": "blur"}})
        self.assertTrue(self.run_regions(blur, self.sheet("to_camera"), [(10, 10, 60, 60)], [])[0])
        # Someone else's face in the same shot: every face is blurred.
        self.assertTrue(self.run_regions(shown, self.sheet("to_camera", ["face"]), [(10, 10, 60, 60)], [])[0])

    def test_finder_failure_fails_closed(self):
        r = PR.rules_from({"content_rules": RULES})

        def boom(img):
            raise RuntimeError("no finder")

        old = PR._frame
        PR._frame = lambda video, t, out: object()
        try:
            _regions, ok = PR.privacy_regions(Path("v.mp4"), 2.0, r, self.sheet("others"), Path("/tmp/protect-test"), (boom, boom))
        finally:
            PR._frame = old
        self.assertFalse(ok)

    def test_blur_only_while_on_screen(self):
        chain, last = PR.blur_filter([(1.0, 2.5, (10, 10, 60, 60))], 1080, 1920)
        self.assertIn("enable='between(t,1.00,2.50)'", chain)
        self.assertEqual(last, "[o0]")

    def test_no_rules_no_work(self):
        self.assertEqual(PR.privacy_regions(Path("v.mp4"), 4.0, PR.rules_from({}), None, Path("/tmp"), None), ([], True))


if __name__ == "__main__":
    unittest.main()
