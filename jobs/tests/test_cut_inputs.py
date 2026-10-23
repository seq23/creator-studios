"""Full-quality phone footage reaches the cut (23 Oct 2026, the Porch & Party re-upload).

Two faults dropped a whole job's footage from one dump: every iPhone HEIC photo was "unreadable"
(the runner's static ffmpeg has no HEIF reader), and every second of every handheld walk-through
video scored as shake (the shift search read a walk-in or a dim room as random jumps), so no video
shot could be a hero and only the AI pictures were cut. These pin both.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import cut as C  # noqa: E402
import stages as ST  # noqa: E402

HAS_FFMPEG = shutil.which("ffmpeg") is not None
try:
    import pillow_heif  # type: ignore  # noqa: F401

    HAS_HEIF = True
except Exception:  # noqa: BLE001
    HAS_HEIF = False
IN_CI = bool(os.environ.get("CI"))


def make(path: Path, src: str, vf: str, seconds: int = 4) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"{src}:d={seconds}:r=30", "-vf", vf, "-pix_fmt", "yuv420p", str(path)], check=True)


class Heic(unittest.TestCase):
    def test_heif_is_known_by_its_bytes_not_its_name(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / "raw_0").write_bytes(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64)
            (tmp / "raw_1").write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 64)
            (tmp / "raw_2").write_bytes(b"\x00\x00\x00\x18ftypqt  \x00\x00\x00\x00qt  " + b"\x00" * 64)
            self.assertTrue(C.is_heif(tmp / "raw_0"))
            self.assertFalse(C.is_heif(tmp / "raw_1"))
            self.assertFalse(C.is_heif(tmp / "raw_2"))  # an iPhone .MOV is not a photo
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @unittest.skipUnless(HAS_HEIF or IN_CI, "pillow-heif (installed in CI)")
    def test_an_iphone_heic_reaches_ffmpeg_as_a_jpeg(self):
        from PIL import Image
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
        tmp = Path(tempfile.mkdtemp())
        try:
            raw = tmp / "raw_3"
            Image.new("RGB", (640, 480), (200, 40, 40)).save(raw, format="HEIF")
            self.assertTrue(C.is_heif(raw))
            seen: list[str] = []

            def fake_ffmpeg(args):
                src = args[args.index("-i") + 1]
                seen.append(src)
                with open(src, "rb") as f:
                    self.assertEqual(f.read(2), b"\xff\xd8")  # a JPEG, which every ffmpeg reads
                raise subprocess.CalledProcessError(1, "ffmpeg")

            with mock.patch.object(C, "ffmpeg", fake_ffmpeg), self.assertRaises(subprocess.CalledProcessError):
                C.photo_video(raw, tmp / "n.mp4")
            self.assertEqual(len(seen), 1)
            self.assertNotEqual(seen[0], str(raw))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
class Steadiness(unittest.TestCase):
    def test_a_walk_in_is_not_shake_but_a_jumping_picture_is(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            walk, shake = tmp / "walk.mp4", tmp / "shake.mp4"
            # Walking in: the picture grows steadily, far past what the shift search can follow.
            make(walk, "testsrc2=s=1080x1920", "zoompan=z='1+0.25*in/30':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=540x960:fps=30")
            # Shake: the picture jumps back and forth by a few percent every few frames.
            make(shake, "testsrc2=s=1200x2100", "crop=1080:1920:x='60+60*sin(2*PI*1.7*t)*cos(2*PI*3.1*t)':y='90+90*cos(2*PI*1.3*t)*sin(2*PI*2.3*t)',scale=540:960")
            w, s = ST.quality_track(walk, 4), ST.quality_track(shake, 4)
            self.assertGreaterEqual(min(w), ST.GOOD, w)
            self.assertLess(sum(s) / len(s), ST.GOOD, s)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_an_unmeasurable_move_is_none_and_a_real_jump_is_measured(self):
        a = bytes((x * 7 + y * 13) % 251 for y in range(ST.QH) for x in range(ST.QW))
        moved = bytes(a[min(ST.QH - 1, y + 4) * ST.QW + min(ST.QW - 1, x + 2)] for y in range(ST.QH) for x in range(ST.QW))
        self.assertGreater(ST.shift(a, moved) or 0, 0)
        noise = bytes((x * 31 + y * 17 + (x * y) % 97) % 256 for y in range(ST.QH) for x in range(ST.QW))
        self.assertIsNone(ST.shift(a, noise))
        self.assertEqual(ST.shift(a, a), 0.0)


if __name__ == "__main__":
    unittest.main()
