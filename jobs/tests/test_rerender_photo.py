"""A re-render of a clip made from a photo (owner's studio, 7 Nov 2026: 17 re-renders of photo clips
failed with "no video stream"). A photo source is made into the same slow-pan shot the cut made,
long enough for every stretch; a video source is untouched. Real ffmpeg on synthetic TEST media.
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


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class RerenderPhoto(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work, True)

    def make(self, name: str, args: list[str]) -> Path:
        p = self.work / name
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args, str(p)], check=True)
        return p

    def test_photos_are_photos_and_videos_are_not(self) -> None:
        jpg = self.make("a.jpg", ["-f", "lavfi", "-i", "color=c=red:size=800x1000", "-frames:v", "1"])
        png = self.make("b.png", ["-f", "lavfi", "-i", "color=c=blue:size=800x1000", "-frames:v", "1"])
        mp4 = self.make("c.mp4", ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast"])
        # The stored key has no extension, as raw/<dump>/<asset> does.
        for p in (jpg, png, mp4):
            p.rename(p.with_suffix(""))
        self.assertTrue(cut.is_photo_file(self.work / "a"))
        self.assertTrue(cut.is_photo_file(self.work / "b"))
        self.assertFalse(cut.is_photo_file(self.work / "c"))

    def test_a_photo_source_becomes_a_shot_long_enough_for_its_stretch(self) -> None:
        jpg = self.make("p.jpg", ["-f", "lavfi", "-i", "color=c=red:size=800x1000", "-frames:v", "1"])
        with self.assertRaises((cut.NoUsableMoments, subprocess.CalledProcessError)):
            cut.normalize(jpg, self.work / "n.mp4", (0.0, 5.5))  # what the re-render did before
        info = cut.photo_video(jpg, self.work / "n.mp4", max(cut.PHOTO_SECONDS, 5.5))
        self.assertGreaterEqual(info["duration"], 5.4)
        self.assertTrue(info["has_video"])


if __name__ == "__main__":
    unittest.main()
