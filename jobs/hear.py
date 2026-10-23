"""HEAR it (studio intelligence layer 3, owner's plan 22 Oct 2026).

The sound of every video is labelled, stretch by stretch:
  talking_to_camera  words are heard while the shot sheet (jobs/see.py) shows someone facing and
                     talking to the camera;
  chatter            words are heard but nobody talks to the camera (guests, a phone call, the TV);
  music              there is sound but no words;
  silence            nothing above the noise floor.
Only talking_to_camera becomes captions, picks speech moments, or keeps the camera sound under
"Automatic". "Off" and "Keep it" stay exactly what she chose (jobs/cut.py camera_keep).

When nobody could look at the video (no shot sheet at all), words cannot be told apart, so they
are labelled talking_to_camera as before (the camera-sound rule alone decides), and the label
record says unseen=True. Pure functions; pinned by jobs/tests/test_hear.py. No business words.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

LABELS = ("talking_to_camera", "chatter", "music", "silence")
STEP = 0.25


@dataclass
class Sound:
    start: float
    end: float
    label: str

    @property
    def length(self) -> float:
        return max(0.0, self.end - self.start)


def _covers(spans: list[tuple[float, float]], a: float, b: float) -> bool:
    return any(s < b and e > a for s, e in spans)


def sound_segments(duration: float, runs: list[tuple[float, float]], words: list[Any], to_camera: list[tuple[float, float]], seen: bool) -> list[Sound]:
    """The video's sound as labelled stretches covering 0..duration, neighbours with one label joined."""
    if duration <= 0:
        return []
    spans = [(float(w.start), float(w.end)) for w in words]
    out: list[Sound] = []
    t = 0.0
    while t < duration - 1e-6:
        e = min(duration, t + STEP)
        if _covers(spans, t, e):
            label = "talking_to_camera" if (not seen or _covers(to_camera, t, e)) else "chatter"
        elif _covers(runs, t, e):
            label = "music"
        else:
            label = "silence"
        if out and out[-1].label == label:
            out[-1].end = round(e, 2)
        else:
            out.append(Sound(round(t, 2), round(e, 2), label))
        t = e
    return out


def share(segments: list[Sound], label: str, duration: float) -> float:
    return sum(s.length for s in segments if s.label == label) / max(1.0, duration)


def talk_windows(segments: list[Sound]) -> list[tuple[float, float]]:
    return [(s.start, s.end) for s in segments if s.label == "talking_to_camera"]


def caption_words(words: list[Any], segments: list[Sound]) -> list[Any]:
    """Only words said to the camera become captions (or pick speech moments)."""
    wins = talk_windows(segments)
    return [w for w in words if any(s - 0.1 <= w.start and w.end <= e + 0.1 for s, e in wins)]


def summary(segments: list[Sound]) -> dict[str, float]:
    """Seconds per label (what the job logs and returns; never the words)."""
    out = {k: 0.0 for k in LABELS}
    for s in segments:
        out[s.label] = round(out[s.label] + s.length, 2)
    return out
