"""A final photo (owner, 7 Nov 2026: a clip that shows the room half done "must END on the finished
product"). A re-render with spec.final_photo_key appends the photo as the last shot: held in the clear,
then under the end card, and the clip gets that much longer. Real ffmpeg on synthetic TEST footage.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cut  # noqa: E402
import looks as L  # noqa: E402


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class FinalPhoto(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work, True)
        self.video = self.work / "src.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(self.video)], check=True)
        self.photo = self.work / "finished.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=1122x1402", "-frames:v", "1", str(self.photo)], check=True)

    def test_no_photo_no_extra_shot(self) -> None:
        self.assertIsNone(cut.final_still({"final_photo_key": ""}, self.work, lambda k, d: d))

    def test_photo_becomes_the_last_shot_and_the_clip_grows_by_it(self) -> None:
        def download(key: str, dest: Path) -> Path:
            self.assertEqual(key, "clips/dmp_x/clp_x-final-1.jpg")
            shutil.copy(self.photo, dest)
            return dest

        final = cut.final_still({"final_photo_key": "clips/dmp_x/clp_x-final-1.jpg"}, self.work, download)
        assert final is not None
        self.assertAlmostEqual(final.dur, cut.FINAL_HOLD_S + L.CARD_SECONDS, places=2)
        info = cut.probe(final.path)
        self.assertEqual((info["width"], info["height"]), (cut.OUT_W, cut.OUT_H))
        self.assertTrue(info["has_audio"])
        opts = {**L.look_options("clean"), "mute": True}
        seg = L.Seg(self.video, 0.0, 5.0, 1080, 1920)
        plain = L.render_look(opts, [seg], [], "Wait for it…", L.Branding(), self.work, "plain")
        ended = L.render_look(opts, [seg, final], [], "Wait for it…", L.Branding(), self.work, "ended")
        grow = cut.probe(ended.mp4)["duration"] - cut.probe(plain.mp4)["duration"]
        self.assertGreater(grow, final.dur - 0.4)
        # The last frame is the photo (red), not the test pattern.
        last = self.work / "last.png"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", "-0.1", "-i", str(ended.mp4), "-frames:v", "1", "-vf", "crop=200:200:440:300,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", str(last)], check=True)
        r, g, b = last.read_bytes()[:3]
        self.assertGreater(r, 150)
        self.assertLess(g, 90)


if __name__ == "__main__":
    unittest.main()
