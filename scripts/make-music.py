#!/usr/bin/env python3
"""The built-in music library (jobs/music/): short, warm, upbeat instrumental beds made from
scratch by this script, so their licence is beyond doubt. Every track is an original work generated
here (no samples, no loops from anywhere else) and dedicated to the public domain under CC0 1.0
(jobs/music/library.json records each one). $0, no paid service.

Owner, 22 Oct 2026: clips with the camera sound off must never be silent; with no songs of her own
the studio uses these. Run it again only to remake the files (deterministic: same seed, same notes):

    python3 scripts/make-music.py            # writes jobs/music/<id>.mp3 (needs ffmpeg)

Pure Python (no numpy), 22.05 kHz, then ffmpeg makes a 112 kb/s stereo MP3 at about -18 LUFS (the cut
mixes it under everything at 0.22 and levels the whole clip to -14 LUFS).
"""
from __future__ import annotations

import array
import json
import math
import random
import subprocess
import sys
import wave
from pathlib import Path

SR = 22050
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "jobs" / "music"

NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
MAJOR = [0, 2, 4, 5, 7, 9, 11]


def freq(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def chord(key: int, degree: int, octave: int = 4) -> list[int]:
    """Triad on a scale degree (0-based) of a major key, as MIDI notes."""
    base = 12 * (octave + 1) + key
    notes = []
    for step in (0, 2, 4):
        d = degree + step
        notes.append(base + MAJOR[d % 7] + 12 * (d // 7))
    return notes


# id, title, key, bpm, progression (scale degrees), feel
TRACKS = [
    ("bright-morning", "Bright Morning", "C", 104, [0, 4, 5, 3], "pluck"),
    ("easy-stroll", "Easy Stroll", "F", 92, [0, 5, 3, 4], "pad"),
    ("pop-up", "Pop Up", "G", 118, [0, 3, 4, 3], "bounce"),
    ("slow-glow", "Slow Glow", "D", 84, [0, 2, 3, 4], "pad"),
    ("ready-set", "Ready Set", "A", 112, [0, 4, 5, 3], "bounce"),
    ("golden-hour", "Golden Hour", "E", 98, [3, 4, 0, 5], "pluck"),
    ("sunday-best", "Sunday Best", "A#", 108, [0, 3, 0, 4], "pluck"),
    ("big-reveal", "Big Reveal", "C", 96, [5, 3, 0, 4], "bounce"),
]


def env_adsr(n: int, a: float, d: float, s: float, r: float) -> list[float]:
    out = []
    an, dn, rn = max(1, int(a * SR)), max(1, int(d * SR)), max(1, int(r * SR))
    for i in range(n):
        if i < an:
            v = i / an
        elif i < an + dn:
            v = 1 - (1 - s) * (i - an) / dn
        else:
            v = s
        if i > n - rn:
            v *= max(0.0, (n - i) / rn)
        out.append(v)
    return out


def add(buf: array.array, start: int, samples: list[float], gain: float, pan: float) -> None:
    """Mix mono samples into the stereo buffer (interleaved), pan -1..1."""
    lg, rg = gain * math.cos((pan + 1) * math.pi / 4), gain * math.sin((pan + 1) * math.pi / 4)
    for i, s in enumerate(samples):
        j = (start + i) * 2
        if j + 1 >= len(buf):
            break
        buf[j] += s * lg
        buf[j + 1] += s * rg


def pad_voice(f: float, n: int, rng: random.Random) -> list[float]:
    """Two detuned soft saws through a one-pole low-pass: a warm pad."""
    e = env_adsr(n, 0.35, 0.4, 0.8, 0.5)
    out = []
    p1, p2 = rng.random(), rng.random()
    lp = 0.0
    k = 0.08
    for i in range(n):
        p1 = (p1 + f * 1.003 / SR) % 1.0
        p2 = (p2 + f * 0.997 / SR) % 1.0
        x = (2 * p1 - 1) + (2 * p2 - 1)
        lp += k * (x - lp)
        out.append(lp * e[i] * 0.5)
    return out


def pluck(f: float, n: int, rng: random.Random) -> list[float]:
    """Karplus-Strong: a soft plucked string."""
    period = max(2, int(SR / f))
    line = [rng.uniform(-1, 1) for _ in range(period)]
    out = []
    idx = 0
    for _ in range(n):
        a = line[idx]
        b = line[(idx + 1) % period]
        line[idx] = 0.497 * (a + b)
        out.append(a)
        idx = (idx + 1) % period
    return out


def bass(f: float, n: int) -> list[float]:
    e = env_adsr(n, 0.01, 0.15, 0.6, 0.08)
    return [(math.sin(2 * math.pi * f * i / SR) + 0.25 * math.sin(4 * math.pi * f * i / SR)) * e[i] for i in range(n)]


def kick(n: int) -> list[float]:
    out = []
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = 45 + 90 * math.exp(-t * 30)
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * math.exp(-t * 9))
    return out


def hat(n: int, rng: random.Random) -> list[float]:
    out = []
    prev = 0.0
    for i in range(n):
        x = rng.uniform(-1, 1)
        hp = x - prev
        prev = x
        out.append(hp * math.exp(-i / SR * 60) * 0.5)
    return out


def clap(n: int, rng: random.Random) -> list[float]:
    return [rng.uniform(-1, 1) * math.exp(-i / SR * 22) * 0.6 for i in range(n)]


def reverb(buf: array.array) -> None:
    """A few feedback delays: a little room so it sounds warm, not dry."""
    for delay_s, fb in ((0.029, 0.32), (0.037, 0.28), (0.041, 0.25)):
        d = int(delay_s * SR) * 2
        for j in range(d, len(buf)):
            buf[j] += buf[j - d] * fb * 0.5


def render(track: tuple, seconds: float = 48.0) -> array.array:
    tid, _title, key_name, bpm, prog, feel = track
    rng = random.Random(tid)
    key = NOTE[key_name]
    n = int(seconds * SR)
    buf = array.array("d", [0.0]) * (n * 2)
    beat = 60.0 / bpm
    bar = beat * 4
    bars = int(seconds / bar)
    for b in range(bars):
        deg = prog[b % len(prog)]
        ch = chord(key, deg, 4)
        start = int(b * bar * SR)
        length = int(bar * SR)
        # pad
        if feel == "pad" or b % 2 == 0:
            for k, m in enumerate(ch):
                add(buf, start, pad_voice(freq(m), length, rng), 0.10 if feel == "pad" else 0.06, -0.4 + 0.4 * k)
        # bass on 1 and 3 (and the "and" of 4 for bounce)
        root = chord(key, deg, 2)[0]
        hits = [0, 2] if feel != "bounce" else [0, 1.5, 2, 3.5]
        for h in hits:
            add(buf, start + int(h * beat * SR), bass(freq(root), int(beat * 0.9 * SR)), 0.28, 0.0)
        # arpeggio / pluck in eighths (the melody-ish part)
        if feel in ("pluck", "bounce") or b >= 2:
            notes = ch + [ch[0] + 12, ch[1] + 12]
            pattern = [0, 1, 2, 3, 2, 1, 4, 2] if feel != "bounce" else [0, 2, 1, 3, 0, 4, 2, 3]
            for e in range(8):
                if feel == "pad" and e % 2:
                    continue
                m = notes[pattern[e] % len(notes)] + 12
                add(buf, start + int(e * beat / 2 * SR), pluck(freq(m), int(beat * 0.9 * SR), rng), 0.12, 0.3 if e % 2 else -0.3)
        # drums (soft): from bar 1 on, so every track opens gently
        if b >= 1:
            for q in range(4):
                t = start + int(q * beat * SR)
                if q in (0, 2) or (feel == "bounce" and q == 3 and b % 2):
                    add(buf, t, kick(int(0.35 * SR)), 0.42 if feel != "pad" else 0.25, 0.0)
                if feel != "pad" and q in (1, 3):
                    add(buf, t, clap(int(0.2 * SR), rng), 0.12, 0.1)
            for e in range(8):
                add(buf, start + int(e * beat / 2 * SR), hat(int(0.06 * SR), rng), 0.08 if e % 2 else 0.05, 0.35)
    reverb(buf)
    peak = max(1e-9, max(abs(x) for x in buf))
    for j in range(len(buf)):
        buf[j] = buf[j] / peak * 0.85
    return buf


def write_wav(buf: array.array, path: Path) -> None:
    pcm = array.array("h", (int(max(-1.0, min(1.0, x)) * 32767) for x in buf))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    for t in TRACKS:
        if only and t[0] not in only:
            continue
        wav = OUT / f"{t[0]}.wav"
        write_wav(render(t), wav)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-af", "afade=t=in:d=1.5,afade=t=out:st=45:d=3,loudnorm=I=-18:TP=-2:LRA=11", "-ar", "44100", "-ac", "2", "-b:a", "112k",
             "-metadata", f"title={t[1]}", "-metadata", "copyright=CC0 1.0 (public domain dedication)", str(OUT / f"{t[0]}.mp3")],
            check=True,
        )
        wav.unlink()
        print("made", t[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
