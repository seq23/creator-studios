"""On-screen words for every voice over (Follow-on V, 23 Oct 2026; jobs/vo_words.py): timed to the
voice, inside the safe area, never over the hook's box, never on screen during the end card.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import looks as L  # noqa: E402
import vo_words as VW  # noqa: E402
import voice  # noqa: E402


def overlap(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


class TimingTest(unittest.TestCase):
    def test_sentences_are_what_the_engines_speak(self) -> None:
        self.assertEqual(VW.split_sentences("Fabric first.  Then the pins! Done"), ["Fabric first.", "Then the pins!", "Done."])
        self.assertEqual(VW.split_sentences("   "), [])

    def test_estimate_shares_the_audio_by_characters_and_covers_it_exactly(self) -> None:
        t = VW.estimate_timings("Short one. This sentence is quite a lot longer than that.", 6.0)
        self.assertEqual(len(t), 2)
        self.assertEqual(t[0][0], 0.0)
        self.assertAlmostEqual(t[-1][1], 6.0, places=2)
        self.assertAlmostEqual(t[0][1], t[1][0], places=3)
        self.assertGreater(t[1][1] - t[1][0], 2 * (t[0][1] - t[0][0]))
        self.assertEqual(VW.estimate_timings("Words.", 0), [])

    def test_cues_follow_the_engine_timings_a_few_words_at_a_time(self) -> None:
        timings = [(0.0, 1.5, "Fabric first."), (1.5, 5.5, "Then we pin every single panel by hand, slowly.")]
        cues = VW.phrase_cues(timings, 20.0)
        self.assertEqual(cues[0], (0.0, 1.5, "Fabric first."))
        self.assertTrue(all(len(c[2].split()) <= VW.PHRASE_WORDS for c in cues))
        # The second sentence's phrases start when it starts and end when it ends, in order.
        second = cues[1:]
        self.assertEqual(second[0][0], 1.5)
        self.assertAlmostEqual(second[-1][1], 5.5, places=2)
        self.assertEqual(" ".join(c[2] for c in second), "Then we pin every single panel by hand, slowly.")
        for a, b in zip(cues, cues[1:]):
            self.assertLessEqual(a[1], b[0] + 1e-6)


class PlacementTest(unittest.TestCase):
    def test_words_never_overlap_the_end_card(self) -> None:
        clip = 9.0
        card = (clip - L.CARD_SECONDS, clip)
        timings = VW.estimate_timings("One two three four five six. Seven eight nine ten. Follow for more today.", 9.0)
        cues = VW.phrase_cues(timings, clip)
        self.assertTrue(cues)
        for s, e, _ in cues:
            self.assertFalse(overlap((s, e), card), (s, e))
        # The ASS file carries no event at or past the card's first frame either.
        ass = VW.build_vo_ass(cues)
        self.assertIsNotNone(ass)
        last_end = max(e for _s, e, _t in cues)
        self.assertLessEqual(last_end, card[0])

    def test_a_short_clip_has_no_card_and_keeps_its_words(self) -> None:
        self.assertEqual(VW.words_until(3.5), 3.5)
        self.assertEqual(VW.words_until(10.0), 10.0 - L.CARD_SECONDS)

    def test_the_band_sits_below_the_hook_above_the_captions_inside_the_safe_area(self) -> None:
        band = VW.words_band()
        self.assertFalse(overlap(band, VW.hook_band()), (band, VW.hook_band()))
        self.assertFalse(overlap(band, VW.caption_band()), (band, VW.caption_band()))
        self.assertGreaterEqual(band[0], L.SAFE["y0"])
        self.assertLessEqual(band[1], L.SAFE["y1"])
        # The end card's call to action is in the same lower part of the frame: that is why time keeps them apart.
        self.assertTrue(overlap(band, (L.CTA_Y - L.CTA_SIZE, L.CTA_Y + L.CTA_SIZE)))

    def test_the_ass_style_is_bottom_aligned_at_the_band(self) -> None:
        ass = VW.build_vo_ass([(0.5, 1.5, "Fabric first.")]) or ""
        style = next(l for l in ass.splitlines() if l.startswith("Style: Vo,"))
        fields = style.split(",")
        self.assertEqual(fields[18], "2")  # bottom-centre
        self.assertEqual(int(fields[21]), L.OUT_H - VW.VO_BOTTOM)
        self.assertEqual((int(fields[19]), int(fields[20])), (L.SAFE["x0"], L.OUT_W - L.SAFE["x1"]))
        self.assertIn("Dialogue: 1,0:00:00.50,0:00:01.50,Vo,,0,0,0,,Fabric first.", ass)
        self.assertIsNone(VW.build_vo_ass([]))


class MixTest(unittest.TestCase):
    def test_mix_with_words_burns_them_and_without_copies_the_video(self) -> None:
        p = Path("/tmp/x")
        burned = voice.mix_command(p / "c.mp4", p / "v.mp3", p / "o.mp4", True, p / "w.ass")
        self.assertIn(f"subtitles=filename='{(p / 'w.ass').resolve()}'", burned[burned.index("-filter_complex") + 1])
        self.assertEqual(burned[burned.index("-map") + 1], "[v]")
        plain = voice.mix_command(p / "c.mp4", p / "v.mp3", p / "o.mp4", True)
        self.assertEqual(plain[plain.index("-c:v") + 1], "copy")
        self.assertEqual(plain[plain.index("-map") + 1], "0:v:0")


if __name__ == "__main__":
    unittest.main()


class RealFfmpegTest(unittest.TestCase):
    """The burn for real (CI's static ffmpeg has libass): a 6 s fixture clip, a 4 s tone as the voice."""

    def test_words_burn_and_the_clip_keeps_its_length(self) -> None:
        import shutil
        import subprocess
        import tempfile

        if not shutil.which("ffmpeg") or not L.has_filter("subtitles"):
            self.skipTest("no ffmpeg with libass here (CI has one)")
        with tempfile.TemporaryDirectory() as d:
            w = Path(d)
            clip, vo, out = w / "clip.mp4", w / "vo.mp3", w / "out.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920:d=6:r=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)], check=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=220:d=4", str(vo)], check=True)
            words, n = voice.words_file("Fabric first. Then the pins go in. Follow for more.", None, vo, clip, w, "t")
            self.assertIsNotNone(words)
            self.assertGreater(n, 0)
            subprocess.run(voice.mix_command(clip, vo, out, True, words), check=True)
            self.assertAlmostEqual(voice.duration_of(out), 6.0, delta=0.2)
