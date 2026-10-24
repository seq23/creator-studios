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


class DigitRunTest(unittest.TestCase):
    def test_single_digits_on_one_line_join_into_a_run(self):
        words = [((300, 1480, 380, 1630), "4"), ((400, 1480, 480, 1630), "5"), ((500, 1480, 580, 1630), "2"), ((600, 1480, 680, 1630), "1"), ((100, 100, 140, 150), "7"), ((300, 1700, 380, 1850), "9")]
        runs = [w for w in PR.join_digit_runs(words) if len(w[1]) > 1]
        self.assertEqual(runs, [((300, 1480, 680, 1630), "4521")])  # the 7 far away and the 9 on the next line stay alone


class NumberScalesTest(unittest.TestCase):
    def test_big_numerals_get_a_quarter_size_read(self):
        """23 Oct 2026: tesseract's sparse mode misses a door number drawn 220 px tall at full and half
        size and reads it only at a quarter size; the finder must look at all three."""
        from unittest import mock
        from PIL import Image

        sizes: list[tuple[int, int]] = []

        def fake_run(cmd, **_kw):
            sizes.append(Image.open(cmd[1]).size)
            return mock.Mock(returncode=0, stdout="h\n")

        with mock.patch.object(PR.subprocess, "run", fake_run):
            PR.numbers_with_text(Image.new("RGB", (1080, 1920)))
        self.assertEqual(sizes, [(1080, 1920), (540, 960), (270, 480)])


class BlurPatchTest(unittest.TestCase):
    """23 Oct 2026: 7 of 45 videos in one dump had every clip hidden "a face, house number or name may
    be showing" with no face found: a small house-number box made ffmpeg refuse boxblur=24 ("must be
    >= 0 and < 16"), the blur pass failed, and the cut failed closed. Every patch must be one ffmpeg
    accepts, and the blurred area is never smaller than MIN_BOX a side (inside the frame)."""

    def test_small_boxes_get_radii_ffmpeg_accepts(self):
        for box in [(100, 100, 102, 101), (100, 100, 110, 108), (100, 100, 130, 120), (0, 0, 4, 4), (1076, 1916, 1080, 1920), (10, 10, 600, 400)]:
            x, y, w, h = PR.blur_box(box, 1080, 1920)
            self.assertTrue(0 <= x and 0 <= y and x + w <= 1080 and y + h <= 1920, (box, x, y, w, h))
            self.assertEqual((w % 2, h % 2), (0, 0))
            self.assertGreaterEqual(min(w, h), PR.MIN_BOX, box)
            lr, cr = PR.blur_radii(w, h)
            self.assertLess(lr, min(w, h) / 2, box)
            self.assertLess(cr, min(w // 2, h // 2) / 2, box)
            self.assertGreaterEqual(cr, 8, box)  # still a hard blur, not a token one

    def test_box_covers_what_was_found(self):
        x, y, w, h = PR.blur_box((500, 900, 560, 940), 1080, 1920)
        self.assertTrue(x <= 500 and y <= 900 and x + w >= 560 and y + h >= 940)

    def test_source_split_once_per_use(self):
        chain, last = PR.blur_filter([(1.0, 2.5, (10, 10, 20, 18)), (3.0, 4.0, (300, 300, 320, 310))], 1080, 1920)
        self.assertTrue(chain.startswith("[0:v]split=3[base][s0][s1];"))
        self.assertEqual(chain.count("[0:v]"), 1)
        self.assertNotIn("boxblur=24", chain)
        self.assertEqual(last, "[o1]")

    def test_cause_not_last_line(self):
        err = "[Parsed_boxblur_1 @ 0x1] Invalid luma_param radius value 24, must be >= 0 and < 16\n[out#0/mp4 @ 0x2] Nothing was written into output file, because at least one of its streams received no packets."
        self.assertIn("radius value 24", PR.ffmpeg_error(err))

    @unittest.skipUnless(__import__("shutil").which("ffmpeg"), "ffmpeg not installed")
    def test_tiny_box_blurs_for_real(self):
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "v.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=2", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)], check=True, capture_output=True)
            out = PR.blur_video(src, [(0.0, 1.2, (100, 100, 110, 108)), (0.5, 2.0, (1070, 1910, 1080, 1920))], 1080, 1920, Path(d) / "safe.mp4")
            self.assertGreater(out.stat().st_size, 0)


class UnprotectedReasonTest(unittest.TestCase):
    def test_a_failed_blur_never_says_a_face_was_seen(self):
        import critic as C

        self.assertNotEqual(C.REASON_WORDS["unprotected"], C.REASON_WORDS["privacy"])
        src = (ROOT / "jobs" / "cut.py").read_text()
        self.assertIn('m.hidden_reason = C.REASON_WORDS["unprotected"]', src)
        self.assertNotIn('in unsafe for a in part_owners(m)):\n            m.hidden_reason = C.REASON_WORDS["privacy"]', src)
