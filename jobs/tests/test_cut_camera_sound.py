"""Camera sound off and the built-in music library (owner, 22 Oct 2026): a dump of phone videos whose
camera audio is only background talk was cut into clips whose captions were that talk. With the
camera sound off, the cut uses none of the source's sound (nothing transcribed, nothing heard in the
clip), the clip counts as having no talking (so automatic voice over applies), and it always gets a
music bed: her songs, else the built-in CC0 library, never silence. Real ffmpeg on synthetic TEST
footage; storage stubbed. Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cut  # noqa: E402
import looks as L  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
ROOT = Path(__file__).resolve().parents[2]


def words(*spans: tuple[float, float]) -> cut.Transcript:
    t = cut.Transcript(engine="faster-whisper")
    for s, e in spans:
        t.words.append(L.Word(s, e, "word"))
    return t


class CameraRule(unittest.TestCase):
    def test_off_and_keep_are_what_they_say(self) -> None:
        self.assertEqual(cut.camera_keep("off", words((0, 20)), 20), (False, "off"))
        self.assertEqual(cut.camera_keep("keep", words(), 20), (True, "keep"))

    def test_auto_drops_background_talk_and_keeps_someone_talking(self) -> None:
        # Two stray words in 20 s: background chatter, dropped.
        self.assertEqual(cut.camera_keep("auto", words((3, 3.4), (9, 9.5)), 20), (False, "little_talk"))
        # Talk over most of it: someone talking to the camera, kept.
        self.assertEqual(cut.camera_keep("auto", words(*[(i, i + 0.8) for i in range(0, 20)]), 20), (True, "talking"))
        # Nothing to tell talk from noise with: kept (never mutes a creator by guesswork).
        self.assertEqual(cut.camera_keep("auto", cut.Transcript(engine="none"), 20), (True, "unmeasured"))

    def test_mode_comes_from_the_video_then_the_dump(self) -> None:
        self.assertEqual(cut.camera_mode({"camera": "off"}, {"id": "a"}), "off")
        self.assertEqual(cut.camera_mode({"camera": "off"}, {"id": "a", "steer": {"camera": "keep"}}), "keep")
        self.assertEqual(cut.camera_mode({}, None), "keep")
        self.assertEqual(cut.camera_mode({"camera": "loud"}, None), "keep")


class Library(unittest.TestCase):
    def test_every_track_is_on_disk_with_an_open_licence(self) -> None:
        lib = json.loads((ROOT / "jobs" / "music" / "library.json").read_text())
        self.assertGreaterEqual(len(lib["tracks"]), 6)
        self.assertLessEqual(len(lib["tracks"]), 10)
        for t in lib["tracks"]:
            self.assertTrue((ROOT / t["file"]).exists(), t["id"])
            self.assertIn("CC0", t["licence"])
            self.assertTrue(t["source"])

    def test_a_muted_clip_always_gets_a_song(self) -> None:
        self.assertIsNone(cut.music_key({"music": []}, 0))
        self.assertTrue(cut.music_key({"music": []}, 0, muted=True).startswith("library/"))
        # Her own songs come first.
        self.assertEqual(cut.music_key({"music": [{"r2_key": "music/abcd1234"}]}, 3, muted=True), "music/abcd1234")
        # One per clip in turn.
        self.assertNotEqual(cut.music_key({}, 0, True), cut.music_key({}, 1, True))
        # A library id that is not on disk is never sent to ffmpeg.
        self.assertIsNone(cut.music_key({"music": [{"r2_key": "library/nope"}]}, 0))


def make(path: Path, seconds: int) -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size=360x640:rate=25:duration={seconds}", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path)],
        check=True,
    )
    return path


def volume(path: Path) -> float:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    m = re.search(r"max_volume: (-?[\d.]+) dB", out)
    return float(m.group(1)) if m else -999.0


def tone_share(path: Path) -> float:
    """How much of the sound is the 440 Hz test tone the source carries (bandpass vs whole)."""
    def mean(af: str) -> float:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", f"{af}volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
        m = re.search(r"mean_volume: (-?[\d.]+) dB", out)
        return float(m.group(1)) if m else -999.0
    return mean("bandpass=f=440:width_type=q:w=30,") - mean("")


@unittest.skipUnless(FFMPEG, "ffmpeg is not installed")
class MutedCut(unittest.TestCase):
    def test_a_dump_cut_with_camera_sound_off(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            src = make(work / "src.mp4", 12)
            uploads: dict[str, Path] = {}

            def download(key: str, dest: Path) -> Path:
                shutil.copy(src, dest)
                return dest

            def upload(path: Path, key: str, _ct: str) -> None:
                kept = work / "out" / key.replace("/", "_")
                kept.parent.mkdir(exist_ok=True)
                shutil.copy(path, kept)
                uploads[key] = kept

            spec = {
                "dump_id": "dmp_test", "door": "new", "notes": "", "camera": "off", "output_prefix": "clips/dmp_test/",
                "assets": [{"id": "ast_a", "r2_key": "raw/a", "allowed_platforms": ["tiktok"]}],
                "target_clips": {"min": 1, "max": 1}, "rotation": ["clean"], "looks": {"clean": {"captions": "clean", "hook": "top_bold"}},
                "music": [], "steer": {},
            }
            out = cut.cut_dump(spec, work / "w", download, upload, lambda *_: None, {"whisper": False, "mediapipe": False})
            self.assertEqual(out["camera"], {"ast_a": "off"})
            self.assertTrue(out["clips"])
            for c in out["clips"]:
                self.assertTrue(c["muted"])
                self.assertEqual(c["speech"], 0.0)  # counts as no talking: automatic voice over applies
                self.assertTrue(str(c["music"]).startswith("library/"))  # never silent
                mp4 = uploads[c["r2_key"]]
                self.assertGreater(volume(mp4), -40)  # music is there
                self.assertLess(tone_share(mp4), -12)  # the camera's own sound is not

    def test_render_with_mute_and_no_music_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            src = make(work / "src.mp4", 6)
            info = cut.probe(src)
            seg = L.Seg(src, 0.0, 5.0, info["width"], info["height"])
            opts = {**L.look_options("clean"), "mute": True}
            r = L.render_look(opts, [seg], [], "", L.branding_from(None, work), work, "clip")
            self.assertLess(volume(r.mp4), -80)
            kept = L.render_look(L.look_options("clean"), [seg], [], "", L.branding_from(None, work), work, "clip2")
            self.assertGreater(volume(kept.mp4), -30)


if __name__ == "__main__":
    unittest.main()
