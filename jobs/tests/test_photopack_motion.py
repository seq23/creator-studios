"""Realistic motion in the photo maker (jobs/photopack.py, owner's word 22 Oct 2026): no token means
no Hugging Face call at all; a busy or failing model is retried a bounded number of times and then
the slow zoom is used, so a post never waits. With real ffmpeg when it is installed.
Run: python3 -m unittest discover -s jobs/tests
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
import photopack  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
try:
    import PIL  # noqa: F401
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


class NoToken(unittest.TestCase):
    def test_no_token_makes_no_call(self) -> None:
        call = mock.Mock(side_effect=AssertionError("called"))
        with mock.patch.object(photopack, "_hf_call", side_effect=AssertionError("called")) as hf:
            self.assertFalse(photopack.realistic_clip(Path("x.jpg"), Path("y.mp4"), 3.0, None, call=call))
            self.assertFalse(photopack.realistic_clip(Path("x.jpg"), Path("y.mp4"), 3.0, "", call=call))
            hf.assert_not_called()
        call.assert_not_called()

    def test_no_gradio_import_without_token(self) -> None:
        sys.modules.pop("gradio_client", None)
        photopack.realistic_clip(Path("x.jpg"), Path("y.mp4"), 3.0, None)
        self.assertNotIn("gradio_client", sys.modules)


class Fallback(unittest.TestCase):
    def test_failure_is_retried_then_gives_up(self) -> None:
        call = mock.Mock(side_effect=RuntimeError("busy"))
        ok = photopack.realistic_clip(Path("x.jpg"), Path("y.mp4"), 3.0, "hf_test", call=call, attempts=2, wait_s=0)
        self.assertFalse(ok)
        self.assertEqual(call.call_count, 2)  # bounded

    def test_attempts_are_bounded_by_default(self) -> None:
        self.assertGreaterEqual(photopack.HF_ATTEMPTS, 1)
        self.assertLessEqual(photopack.HF_ATTEMPTS, 3)
        self.assertLessEqual(photopack.HF_TIMEOUT_S, 300)

    def test_space_model_licence_note_is_present(self) -> None:
        src = Path(photopack.__file__).read_text()
        self.assertIn("apache-2.0", src)
        self.assertIn("Wan-AI/Wan2.2-I2V-A14B", src)


@unittest.skipUnless(FFMPEG and HAVE_PIL, "ffmpeg or pillow not installed")
class Pack(unittest.TestCase):
    def _photo(self, d: Path) -> Path:
        from PIL import Image

        p = d / "porch.jpg"
        Image.new("RGB", (800, 1000), (120, 160, 110)).save(p, "JPEG")
        return p

    def test_pack_falls_back_to_slow_zoom_when_the_model_fails(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            p = self._photo(d)
            with mock.patch.object(photopack, "_hf_call", side_effect=RuntimeError("rate limited")), mock.patch.object(photopack, "HF_WAIT_S", 0), \
                 mock.patch.object(photopack, "check_photo", side_effect=lambda img, strict: (img, 0, 0, True)):
                made = photopack.make_pack([(p, "main")], d, False, False, "hf_test")
            self.assertEqual(made["motion"], "slow-zoom")
            self.assertGreater(photopack.probe_duration(made["reel"]), 3)

    def test_pack_uses_the_realistic_clip_when_the_model_answers(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            p = self._photo(d)
            fake = d / "model.mp4"  # the model's answer: this same photo, moving
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(p), "-t", "3.5", "-r", "16", "-vf", "scale=480:600", "-pix_fmt", "yuv420p", str(fake)], check=True)
            with mock.patch.object(photopack, "_hf_call", return_value=str(fake)), \
                 mock.patch.object(photopack, "check_photo", side_effect=lambda img, strict: (img, 0, 0, True)), \
                 mock.patch.object(photopack, "clip_privacy_boxes", return_value=[]):
                made = photopack.make_pack([(p, "main")], d, False, False, "hf_test")
            self.assertEqual(made["motion"], "realistic")
            self.assertGreater(photopack.probe_duration(made["reel"]), 3)

    def test_a_clip_that_is_no_longer_the_photo_is_refused_for_the_slow_zoom(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            p = self._photo(d)
            other = d / "model.mp4"  # the model invented a different scene
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=480x832:rate=16:duration=3.5", str(other)], check=True)
            with mock.patch.object(photopack, "_hf_call", return_value=str(other)), mock.patch.object(photopack, "HF_WAIT_S", 0), \
                 mock.patch.object(photopack, "check_photo", side_effect=lambda img, strict: (img, 0, 0, True)):
                made = photopack.make_pack([(p, "main")], d, False, False, "hf_test")
            self.assertEqual(made["motion"], "slow-zoom")

    def test_faces_and_numbers_in_the_clip_are_blurred(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            p = self._photo(d)
            fake = d / "model.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(p), "-t", "3.5", "-r", "16", "-pix_fmt", "yuv420p", str(fake)], check=True)
            dst = d / "clip.mp4"
            with mock.patch.object(photopack, "clip_privacy_boxes", return_value=[(400, 600, 600, 800)]) as boxes, \
                 mock.patch.object(photopack, "blur_regions", wraps=photopack.blur_regions) as blur:
                ok = photopack.realistic_clip(p, dst, 3.0, "hf_test", call=lambda: str(fake), wait_s=0)
            self.assertTrue(ok)
            boxes.assert_called_once()
            blur.assert_called_once()
            self.assertGreater(photopack.probe_duration(dst), 2.5)

    def test_prompt_never_asks_for_a_camera(self) -> None:
        self.assertNotIn("camera", photopack.MOTION_PROMPT.lower())
        for w in ("person", "camera", "text"):
            self.assertIn(w, photopack.MOTION_NEGATIVE)

    def test_pack_without_token_is_slow_zoom_and_calls_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            p = self._photo(d)
            with mock.patch.object(photopack, "_hf_call", side_effect=AssertionError("called")) as hf, \
                 mock.patch.object(photopack, "check_photo", side_effect=lambda img, strict: (img, 0, 0, True)):
                made = photopack.make_pack([(p, "main")], d, False, False, None)
            hf.assert_not_called()
            self.assertEqual(made["motion"], "slow-zoom")


if __name__ == "__main__":
    unittest.main()


class SmallBoxBlurTest(unittest.TestCase):
    """23 Oct 2026: a small number box made boxblur=24 fail; the photo clip uses protect's patches."""

    def test_tiny_box_blurs(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            src = d / "v.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size={photopack.W}x{photopack.H}:rate=16:duration=1", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)], check=True)
            photopack.blur_regions(src, [(100, 100, 110, 108)], d / "out.mp4")
            self.assertGreater((d / "out.mp4").stat().st_size, 0)
