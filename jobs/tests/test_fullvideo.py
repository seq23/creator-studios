"""The full-video door's job (jobs/fullvideo.py) with real ffmpeg on synthetic TEST footage: the
video keeps its same size and shape and its length (streams copied, never cropped or made 9:16), a
codec an MP4 can't hold is re-encoded at the same size, and the three thumbnails come from three
different parts. Storage and the transcript are stubbed. Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fullvideo  # noqa: E402

FFMPEG = shutil.which("ffmpeg")


def make(path: Path, w: int, h: int, seconds: int, vcodec: list[str]) -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate=25:duration={seconds}", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", *vcodec, "-c:a", "aac", "-shortest", str(path)],
        check=True,
    )
    return path


class Commands(unittest.TestCase):
    def test_copy_is_a_copy_with_no_filter(self) -> None:
        cmd = fullvideo.copy_command(Path("a.mov"), Path("b.mp4"))
        self.assertIn("copy", cmd)
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")
        self.assertFalse(any(x in ("-vf", "-filter_complex", "-filter:v") for x in cmd))

    def test_reencode_keeps_its_own_size(self) -> None:
        cmd = " ".join(fullvideo.reencode_command(Path("a.mov"), Path("b.mp4")))
        for bad in ("-vf", "scale", "crop", "pad", "1080:1920", "9/16"):
            self.assertNotIn(bad, cmd)

    def test_thumbnails_from_three_parts(self) -> None:
        self.assertEqual(fullvideo.thumb_times(600), [120.0, 300.0, 480.0])
        self.assertEqual(len(set(fullvideo.thumb_times(30))), 3)


@unittest.skipUnless(FFMPEG, "ffmpeg is installed in CI (check.yml); this runs there")
class RealRun(unittest.TestCase):
    def run_main(self, src: Path, work: Path) -> tuple[dict, dict[str, Path]]:
        uploaded: dict[str, Path] = {}

        def upload(p: Path, key: str, ct: str) -> None:
            dest = work / "out" / key.replace("/", "_")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(p, dest)
            uploaded[key] = dest

        job = mock.Mock()
        spec = {"source_key": "raw/dmp_t/ast", "output_key": "full/dmp_t/clp_tfv.mp4", "thumb_keys": [f"full/dmp_t/clp_tfv-t{i}.jpg" for i in (1, 2, 3)]}
        with mock.patch.object(fullvideo, "WORK", work), mock.patch.object(fullvideo, "download_input", lambda key, dest: shutil.copy(src, dest) and dest), mock.patch.object(
            fullvideo, "upload_output", upload
        ), mock.patch.object(fullvideo, "transcript", lambda *a: ("stub", [{"start": 0.0, "end": 2.0, "text": "TEST"}])):
            out = fullvideo.main(job, spec)
        return out, uploaded

    def test_the_whole_video_keeps_the_same_size_and_shape_and_length(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            work = Path(t)
            src = make(work / "landscape.mp4", 1280, 720, 12, ["-c:v", "libx264", "-preset", "ultrafast"])
            out, up = self.run_main(src, work)
            self.assertTrue(out["video"]["copied"])
            v = fullvideo.probe(up["full/dmp_t/clp_tfv.mp4"])
            self.assertEqual((v["width"], v["height"]), (1280, 720))  # same size and shape: not 9:16
            self.assertAlmostEqual(v["duration"], 12, delta=0.6)
            self.assertEqual(len(out["thumbnails"]), 3)
            for k in out["thumbnails"]:
                t_img = fullvideo.probe(up[k["key"]])
                self.assertEqual((t_img["width"], t_img["height"]), (1280, 720))

    def test_a_codec_mp4_cannot_hold_is_re_encoded_at_the_same_size(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            work = Path(t)
            src = make(work / "prores.mov", 960, 540, 6, ["-c:v", "prores_ks", "-profile:v", "0"])
            out, up = self.run_main(src, work)
            self.assertFalse(out["video"]["copied"])
            v = fullvideo.probe(up["full/dmp_t/clp_tfv.mp4"])
            self.assertEqual((v["width"], v["height"], v["vcodec"]), (960, 540, "h264"))


if __name__ == "__main__":
    unittest.main()
