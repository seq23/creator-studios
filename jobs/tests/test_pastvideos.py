"""Learn from my past videos (jobs/pastvideos.py): the numbers per video, the section the rules
write when the free models are silent, the model's lines only when every line is plain words, and
real cut detection on synthetic TEST footage. Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pastvideos as P  # noqa: E402

FFMPEG = shutil.which("ffmpeg")


class Numbers(unittest.TestCase):
    def test_video_stats(self):
        s = P.video_stats(20.0, [0.8, 1.6, 5.0, 10.0, 25.0], [{"start": 0.4, "end": 10.4, "text": "one two three four five six seven eight nine ten"}], True, -18.0, 8.0)
        self.assertEqual(s["cuts"], 4)  # the 25 s "cut" is past the end
        self.assertEqual(s["shot_s"], 4.0)
        self.assertEqual(s["cuts_first_2s"], 2)
        self.assertEqual(s["talk_share"], 0.5)
        self.assertEqual(s["talk_starts_s"], 0.4)
        self.assertEqual(s["words_per_min"], 60)
        self.assertEqual(s["to_camera_share"], 0.4)

    def test_rules_write_every_line_from_the_numbers(self):
        stats = [P.video_stats(d, [x * 1.2 for x in range(1, int(d / 1.2))], [], True, -20.0, 0.0) for d in (12.0, 18.0, 30.0)]
        lines = P.rules_lines(stats, {"first_seconds": "The finished result first"})
        self.assertEqual(list(lines), list(P.LINES))
        self.assertIn("a cut about every 1.2 seconds", lines["Pacing and cut length"])
        self.assertEqual(lines["Typical length"], "12 to 30 seconds.")
        self.assertTrue(lines["Hooks and first 2 seconds"].startswith("The finished result first"))
        self.assertIn("Mostly music", lines["Music and energy"])
        text = P.section_text(lines)
        self.assertEqual(len(text.splitlines()), len(P.LINES))
        self.assertTrue(text.startswith("Hooks and first 2 seconds: "))

    def test_model_lines_only_when_plain_and_complete(self):
        good = {k: "Plain sentence about it." for k in P.LINES}
        self.assertEqual(P.ai_lines(json.dumps(good)), good)
        self.assertIsNone(P.ai_lines(json.dumps({P.LINES[0]: "only one"})))
        self.assertIsNone(P.ai_lines(json.dumps({**good, P.LINES[1]: "1. Analyze the request"})))
        self.assertIsNone(P.ai_lines(None))


class CopyReadsIt(unittest.TestCase):
    def test_copy_prompt_carries_how_her_videos_feel(self):
        import plan

        d = json.loads(plan.copy_prompt([], {"voice": "warm", "video_feel": "Pacing and cut length: Quick."}))
        self.assertEqual(d["how_her_videos_feel"], "Pacing and cut length: Quick.")
        self.assertNotIn("how_her_videos_feel", json.loads(plan.copy_prompt([], {"voice": "warm"})))
        self.assertIn("how_her_videos_feel", plan.COPY_SYSTEM)


@unittest.skipUnless(FFMPEG, "ffmpeg not installed")
class RealCuts(unittest.TestCase):
    def test_finds_the_cuts_in_test_footage(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "three.mp4"
            # Three 2-second solid colours: two hard cuts, at 2 s and 4 s.
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x284:d=2:r=10", "-f", "lavfi", "-i", "color=c=blue:s=160x284:d=2:r=10", "-f", "lavfi", "-i", "color=c=green:s=160x284:d=2:r=10",
                            "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-pix_fmt", "yuv420p", str(out)], check=True)
            cuts = P.cut_times(out)
            self.assertEqual(len(cuts), 2, cuts)
            self.assertAlmostEqual(cuts[0], 2.0, delta=0.2)
            self.assertAlmostEqual(cuts[1], 4.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
