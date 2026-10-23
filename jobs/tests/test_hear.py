"""Studio intelligence layer 3 (owner's plan, 22 Oct 2026): HEAR it.

Pinned: the sound is labelled talking to camera / chatter / music / silence; only talk to the
camera becomes captions; "Automatic" keeps the camera sound only for talk to the camera; "Off" and
"Keep it" stay what she chose.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "jobs"))

import cut  # noqa: E402
import hear as H  # noqa: E402
from looks import Word  # noqa: E402


def words(*spans):
    return [Word(s, e, f"w{i}") for i, (s, e) in enumerate(spans)]


class LabelTest(unittest.TestCase):
    def test_four_labels(self):
        # 0-2 talk to camera, 2-4 music (sound, no words), 4-6 chatter (words, nobody facing the camera), 6-8 silence
        segs = H.sound_segments(8.0, [(0, 6)], words((0.2, 1.8), (4.2, 5.8)), [(0.0, 2.0)], seen=True)
        self.assertEqual([(s.start, s.end, s.label) for s in segs], [(0.0, 2.0, "talking_to_camera"), (2.0, 4.0, "music"), (4.0, 6.0, "chatter"), (6.0, 8.0, "silence")])
        self.assertEqual(H.summary(segs), {"talking_to_camera": 2.0, "chatter": 2.0, "music": 2.0, "silence": 2.0})
        self.assertEqual(sum(H.summary(segs).values()), 8.0)  # covers the whole video

    def test_only_talk_to_camera_becomes_captions(self):
        ws = words((0.2, 1.8), (4.2, 5.8))
        segs = H.sound_segments(8.0, [(0, 6)], ws, [(0.0, 2.0)], seen=True)
        self.assertEqual([w.text for w in H.caption_words(ws, segs)], ["w0"])
        self.assertEqual(H.caption_words(ws, H.sound_segments(8.0, [(0, 6)], ws, [], seen=True)), [])

    def test_unseen_video_keeps_its_words(self):
        ws = words((4.2, 5.8))
        segs = H.sound_segments(8.0, [(0, 6)], ws, [], seen=False)
        self.assertEqual(len(H.caption_words(ws, segs)), 1)


class CameraSoundTest(unittest.TestCase):
    def tr(self):
        return cut.Transcript(words=words((0, 5)), engine="faster-whisper")

    def test_automatic_keeps_only_talk_to_camera(self):
        self.assertEqual(cut.camera_keep("auto", self.tr(), 10.0, 0.5), (True, "talking"))
        # Plenty of words, but none said to the camera (chatter): the sound goes, music plays.
        self.assertEqual(cut.camera_keep("auto", self.tr(), 10.0, 0.0), (False, "no_talk_to_camera"))

    def test_her_choice_stays(self):
        self.assertEqual(cut.camera_keep("off", self.tr(), 10.0, 1.0), (False, "off"))
        self.assertEqual(cut.camera_keep("keep", self.tr(), 10.0, 0.0), (True, "keep"))


if __name__ == "__main__":
    unittest.main()
