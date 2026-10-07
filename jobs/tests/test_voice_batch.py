"""Automatic voice overs, the voice job's batch mode (jobs/voice.py batch): the model loads ONCE for
the whole dump, premium voice overs are only mixed, one clip failing never stops the rest, and the
run reports its minutes. Chatterbox, R2 and ffmpeg are stubbed; the real model runs on staging.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice  # noqa: E402


class FakeJob:
    def __init__(self) -> None:
        self.steps: list[tuple[str, int, int]] = []

    def progress(self, step: str, done: int, total: int) -> None:
        self.steps.append((step, done, total))


def item(n: int, speak: bool = True) -> dict:
    return {
        "narration_id": f"nar_{n}",
        "script": "Three candles. A runner. Follow for more.",
        "speak": speak,
        "narration_key": f"voice/narrations/nar_{n}.mp3",
        "clip_key": f"clips/dmp_1/clp_{n}.mp4",
        "output_key": f"voice/mixed/nar_{n}.mp4",
    }


class BatchTest(unittest.TestCase):
    def run_batch(self, items: list[dict], fail_speak_on: str | None = None):
        loads: list[int] = []
        spoken: list[str] = []
        uploads: list[str] = []
        downloads: list[str] = []

        def load_model(spec, work):
            loads.append(1)
            return object(), False

        def speak(model, script, out_mp3, on_sentence=None):
            if fail_speak_on and fail_speak_on in out_mp3.name:
                raise RuntimeError("model failed")
            spoken.append(out_mp3.name)
            return 6.4

        with mock.patch.object(voice, "load_model", load_model), mock.patch.object(voice, "speak", speak), mock.patch.object(
            voice, "upload_output", lambda path, key, ct: uploads.append(key)
        ), mock.patch.object(voice, "download_input", lambda key, dest: (downloads.append(key), dest)[1]), mock.patch.object(
            voice, "has_audio", lambda p: True
        ), mock.patch.object(voice.subprocess, "run", lambda *a, **k: None):
            job = FakeJob()
            out = voice.batch(job, {"mode": "batch", "items": items, "model_key": "voice/model/conds.pt"})
        return out, loads, spoken, uploads, downloads, job

    def test_model_loads_once_for_the_whole_dump(self) -> None:
        out, loads, spoken, uploads, _, job = self.run_batch([item(1), item(2), item(3)])
        self.assertEqual(len(loads), 1)
        self.assertEqual(len(spoken), 3)
        self.assertEqual([r["ok"] for r in out["items"]], [True, True, True])
        self.assertEqual(uploads, ["voice/narrations/nar_1.mp3", "voice/mixed/nar_1.mp4", "voice/narrations/nar_2.mp3", "voice/mixed/nar_2.mp4", "voice/narrations/nar_3.mp3", "voice/mixed/nar_3.mp4"])
        self.assertEqual(out["items"][0]["mixed_key"], "voice/mixed/nar_1.mp4")
        self.assertEqual(out["mode"], "batch")
        self.assertIsInstance(out["minutes"], float)
        self.assertEqual(job.steps[0][0], "loading your voice")

    def test_premium_only_is_mixed_and_never_loads_the_model(self) -> None:
        out, loads, spoken, uploads, downloads, _ = self.run_batch([item(1, speak=False)])
        self.assertEqual(loads, [])
        self.assertEqual(spoken, [])
        self.assertIn("voice/narrations/nar_1.mp3", downloads)
        self.assertEqual(uploads, ["voice/mixed/nar_1.mp4"])
        self.assertTrue(out["items"][0]["ok"])

    def test_one_clip_failing_never_stops_the_rest(self) -> None:
        out, loads, _, uploads, _, _ = self.run_batch([item(1), item(2), item(3)], fail_speak_on="nar_2")
        self.assertEqual(len(loads), 1)
        self.assertEqual([r["ok"] for r in out["items"]], [True, False, True])
        self.assertNotIn("voice/mixed/nar_2.mp4", uploads)
        self.assertIn("voice/mixed/nar_3.mp4", uploads)


if __name__ == "__main__":
    unittest.main()
