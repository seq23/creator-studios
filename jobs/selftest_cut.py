"""Local self-test for jobs/cut.py: the real ffmpeg pipeline on synthetic footage, no R2, no Worker.

    python3 jobs/selftest_cut.py                  # run and check
    python3 jobs/selftest_cut.py --write-fixture  # also refresh tests/unit/fixtures/cut-result.sample.json
    python3 jobs/selftest_cut.py --keep <dir>     # keep the rendered clips and covers to look at
    python3 jobs/selftest_cut.py --require-heavy  # CI: fail unless whisper, libass and a spoken sample are present
    python3 jobs/selftest_cut.py --looks-only     # just the Looks (every Look rendered and checked)
    python3 jobs/selftest_cut.py --looks-only --looks-kind single|grid   # CI: one half each, in parallel
    python3 jobs/selftest_cut.py --skip-looks     # CI's heavy job: the dump runs without the Looks
    python3 jobs/selftest_cut.py --write-thumbs   # also refresh public/looks/<id>.webp (needs libass + libwebp)

Two synthetic videos (ffmpeg testsrc2 + tone bursts with pauses, so silence detection has
something to find): a 60 s landscape video with black bars through Door A, and a 40 s portrait
video through Door B (recycle). Checks every clip is 1080x1920, has audio near -14 LUFS, has
a cover, sits inside its recipe's length, that every progress stage was reported, and that the
result has exactly the shape the Worker accepts. Exits non-zero on any failure; prints nothing
but log() lines (public-repo rule).

Looks (jobs/looks.json): every Look is rendered on synthetic footage with a synthetic transcript
(so captions have words without whisper) and checked: 1080x1920, the right duration, captions
burned where the Look says (pixels in the caption band differ from the same render with text
off, and do not when the Look has none), the hook at the top, the end card, grid cells where
looks.json puts them (paper-coloured gutters, footage inside each cell), and every two Looks
produce frames far apart by perceptual hash. A dump's clips must use several Looks.

Import mode (another editor's videos): her tall edit replaces a clip, a connected editor's tall
and landscape clips become clips; each is 1080x1920 without stretching, -14 LUFS, length kept.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cut  # noqa: E402
import looks as L  # noqa: E402
import playbook as PB  # noqa: E402
import script_clean as SCL  # noqa: E402
from common import log  # noqa: E402

FIXTURE = HERE.parent / "tests" / "unit" / "fixtures" / "cut-result.sample.json"
CLIP_KEYS = {"id", "asset_id", "start_s", "end_s", "recipe", "hook_text", "hook_alt", "caption", "hashtags", "platforms", "score", "r2_key", "cover_r2_key", "look", "parts", "layout", "music", "speech", "muted", "shape", "service", "on_screen", "part_assets", "hidden_reason",
             # studio fix (the contract with the Worker): type, real score's reasons, hero, files, AI pictures, event, voice script, words pending
             "clip_type", "score_reasons", "hero_asset_id", "files_used", "uses_ai_images", "event_group", "voice_script", "words_pending",
             # Follow-on V: the clip's shots on its own timeline, for the voice-over script
             "shot_list"}
STAGES = {"Getting your videos", "Listening", "Looking at your videos", "Finding the best moments", "Cutting clips", "Saving clips"}


class FakeJob:
    """Stands in for common.Job: records progress instead of calling the Worker."""

    def __init__(self) -> None:
        self.id = "job_selftest"
        self.steps: list[tuple[str, int, int]] = []

    def progress(self, step: str, done: int, total: int) -> None:
        self.steps.append((step, done, total))


SPEECH = (
    "Here is the one thing I never skip in the morning. You need to hear this part. "
    "I make coffee, I write three goals, and I go for a short walk. "
    "Nobody tells you how much that walk changes your whole day. "
    "So this happened last week. I skipped it, and everything felt harder. "
    "Try it tomorrow and tell me how it goes."
)


def speech_track(dest: Path) -> bool:
    """A spoken track (macOS say / Linux espeak-ng) so whisper and word subtitles have words."""
    try:
        if shutil.which("say"):
            subprocess.run(["say", "-o", str(dest.with_suffix(".aiff")), SPEECH], check=True, capture_output=True, timeout=120)
            cut.ffmpeg(["-i", str(dest.with_suffix(".aiff")), "-ar", "48000", str(dest)])
            return True
        if shutil.which("espeak-ng"):
            subprocess.run(["espeak-ng", "-s", "150", "-w", str(dest), SPEECH], check=True, capture_output=True, timeout=120)
            return True
    except Exception:  # noqa: BLE001
        return False
    return False


def make_sample(path: Path, seconds: int, size: str, pad: str | None, speech: Path | None = None) -> None:
    # Without speech: tone for 4.5 s, pause for 1.5 s, so silence detection has runs to find.
    vf = f"pad={pad}:(ow-iw)/2:(oh-ih)/2:black" if pad else "null"
    audio = (
        ["-stream_loop", "-1", "-i", str(speech)]
        if speech
        else ["-f", "lavfi", "-i", f"aevalsrc='0.3*sin(2*PI*330*t)*lt(mod(t\\,6)\\,4.5)':s=48000:d={seconds}"]
    )
    cut.ffmpeg(
        [
            "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
            *audio,
            "-t", str(seconds), "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path),
        ]
    )


def make_scene(path: Path, seconds: int, color: str, box: tuple[int, int, int, int]) -> None:
    """A synthetic shot that is its own picture: a flat colour and a box where no other scene has one."""
    x, y, w, h = box
    cut.ffmpeg([
        "-f", "lavfi", "-i", f"color=c={color}:s=1080x1920:r=30:d={seconds},drawbox=x={x}:y={y}:w={w}:h={h}:color=0x202020:t=fill,drawbox=x={(x + 300) % 900}:y={(y + 700) % 1700}:w=120:h=120:color=0xf0f0f0:t=fill",
        "-f", "lavfi", "-i", f"aevalsrc='0.3*sin(2*PI*330*t)':s=48000:d={seconds}",
        "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path),
    ])


def make_photo(path: Path, color: str, box: tuple[int, int, int, int]) -> None:
    """A synthetic photo with no camera EXIF (so it counts as an AI picture)."""
    x, y, w, h = box
    cut.ffmpeg(["-f", "lavfi", "-i", f"color=c={color}:s=1200x1600,drawbox=x={x}:y={y}:w={w}:h={h}:color=0x303030:t=fill,drawbox=x=80:y=80:w=200:h=200:color=0xffffff:t=fill", "-frames:v", "1", str(path)])


def loudness(path: Path) -> float | None:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    found = re.findall(r"I:\s+(-?[\d.]+) LUFS", proc.stderr)
    return float(found[-1]) if found else None


def spec_for(door: str, dump_id: str, assets: list[dict]) -> dict:
    return {
        "job_id": "job_selftest",
        "type": "cut",
        "dump_id": dump_id,
        "door": door,
        "notes": "selftest",
        "assets": assets,
        "skipped_assets": [],
        "brand_profile": {"themes": "Morning routines\nSmall business life", "ctas": "Follow for more real days"},
        "brief": {"hooks": [{"text": "The one thing I'd never skip."}, {"text": "Nobody tells you this part."}], "themes": [{"title": "Behind the scenes"}]},
        "weekly_caps": {"tiktok": 10, "instagram": 7, "youtube": 5},
        "weekly_need": 10,
        "target_clips": {"min": 4, "max": 6},
        "recipes": cut.DEFAULT_RECIPES,
        "quality_bar": 0.45,
        "output_prefix": f"clips/{dump_id}/",
        # like the Worker's rotationFor: singles and grids interleaved, so a real dump renders grids
        "rotation": ["bold_hook", "karaoke", "grid_four", "cinematic", "clean", "split", "reaction", "brand_card", "grid_eight", "side_by_side", "grid_six", "hero_strip"],
        "branding": {"handle": "@samplestudio", "cta": "Follow for more real days", "colors": {}},
    }


def check(result: dict, spec: dict, out: Path, problems: list[str]) -> None:
    prefix = spec["output_prefix"]
    asset_ids = {a["id"] for a in spec["assets"]}
    if not result.get("clips"):
        problems.append(f"{spec['door']}: no clips")
    for c in result["clips"]:
        n = len(problems)
        if set(c) != CLIP_KEYS:
            problems.append(f"clip keys {sorted(set(c) ^ CLIP_KEYS)}")
        # Follow-on V: the shot list runs in order on the clip's own timeline, inside the clip.
        sl = c.get("shot_list")
        if not isinstance(sl, list) or any(not (isinstance(x, dict) and 0 <= x["t0"] < x["t1"]) for x in sl) or any(a["t1"] > b["t0"] + 0.01 for a, b in zip(sl, sl[1:])) or (sl and sl[-1]["t1"] > c["end_s"] - c["start_s"] + 0.5):
            problems.append("shot_list out of order or outside the clip")
        # No camera choice in the spec keeps the camera sound (jobs/cut.py camera_mode): never muted by default.
        if c.get("muted") is not False:
            problems.append("muted without camera sound off")
        if not re.fullmatch(r"clp_[a-z0-9]{8,32}", c["id"]):
            problems.append("clip id shape")
        if c["asset_id"] not in asset_ids:
            problems.append("asset id not in spec")
        if not (c["r2_key"].startswith(prefix) and c["r2_key"].endswith(".mp4") and c["cover_r2_key"].endswith(".jpg")):
            problems.append("r2 key shape")
        # Studio fix: the score is 0..100 from real checks, with plain reasons (never the old shape bonus).
        if not (isinstance(c["score"], int) and 0 <= c["score"] <= 100) or not c["score_reasons"] or not all(isinstance(x, str) and x for x in c["score_reasons"]):
            problems.append("score range")
        if c["clip_type"] not in PB.TYPES:
            problems.append("clip type not in the playbook")
        if c["words_pending"] != (c["caption"] == "") or (c["words_pending"] and c["hook_text"]):
            problems.append("words pending but stock words shipped (or no words and not pending)")
        if c["voice_script"] and SCL.is_reasoning(c["voice_script"]):
            problems.append("a voice-over script is reasoning-shaped")
        b = cut.DEFAULT_RECIPES[c["recipe"]]
        body = c["end_s"] - c["start_s"]
        if not (3 <= body <= b["maxS"] + 1):
            problems.append(f"{c['recipe']} length {body:.1f}s outside 3..{b['maxS'] + 1}")
        if spec["door"] == "recycle" and c["recipe"] != "recycle":
            problems.append("recycle door made a non-recycle clip")
        if not c["hook_text"] and not c["words_pending"]:
            problems.append("empty hook")
        if not (isinstance(c["speech"], float) and 0.0 <= c["speech"] <= 1.0):
            problems.append("clip has no talking share (speech)")
        if c["look"] not in L.LOOKS:
            problems.append("clip has no known look")
        if not c["parts"] or any(not (e > s_) for s_, e in c["parts"]):
            problems.append("clip parts missing")
        if (L.LOOKS.get(c["look"], {}).get("layout") == "grid") != bool(c["layout"]):
            problems.append("grid look without its cells (or cells on a non-grid look)")
        if c["layout"] and len(c["layout"]["cells"]) != len(L.GRIDS[L.LOOKS[c["look"]]["grid"]]["cells"]):
            problems.append("grid layout has the wrong number of cells")
        mp4 = out / c["r2_key"]
        jpg = out / c["cover_r2_key"]
        if not mp4.exists() or not jpg.exists() or jpg.stat().st_size == 0:
            problems.append("clip or cover not uploaded")
            continue
        info = cut.probe(mp4)
        if (info["width"], info["height"]) != (cut.OUT_W, cut.OUT_H):
            problems.append(f"not 9:16 1080x1920: {info['width']}x{info['height']}")
        if not info["has_audio"]:
            problems.append("no audio")
        if info["duration"] < body - 0.5:
            problems.append("rendered shorter than the cut")
        if spec["door"] == "recycle" and info["duration"] < body + 1.5 and body > 5:
            problems.append("recycle clip has no new first 2 seconds")
        lufs = loudness(mp4)
        if lufs is None or not -17.5 <= lufs <= -10.5:
            problems.append(f"loudness {lufs} LUFS not near -14")
        if len(problems) == n:
            log("selftest.clip.ok", recipe=c["recipe"], seconds=round(info["duration"], 1))


def check_llm(problems: list[str]) -> None:
    """The model picker with a stubbed OpenRouter: its moments are used, bad ones are dropped,
    and a failing call falls back (returns None) instead of failing the dump."""
    import io
    import os
    import urllib.request

    tr = cut.Transcript(words=[cut.Word(float(i), float(i) + 0.8, f"w{i}") for i in range(60)], segments=[(0.0, 60.0, "words")], engine="faster-whisper")
    spec = spec_for("new", "dmp_llm", [])
    asset = {"id": "ast_llm", "file_note": None}
    answer = {"moments": [
        {"start": 2, "end": 32, "recipe": "talking_head", "hook": "Model hook", "hook_alt": "Model alt", "caption": "Model caption", "hashtags": ["#a"], "hook_strength": 0.9},
        {"start": 5, "end": 7, "recipe": "story", "hook": "too short"},
        {"start": 0, "end": 30, "recipe": "ai_video", "hook": "not a recipe"},
    ]}

    class Res(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    real = urllib.request.urlopen
    real_sleep = cut.time.sleep
    os.environ["OPENROUTER_API_KEY"] = "selftest-not-a-key"
    try:
        urllib.request.urlopen = lambda *a, **k: Res(json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode())  # type: ignore[assignment]
        got = cut.llm_moments(asset, 60.0, tr, spec, 5, [(0.0, 60.0)])
        if not got or len(got) != 1 or got[0].hook != "Model hook" or got[0].hook_strength != 0.9:
            problems.append("model moments not used as answered")

        def boom(*_a, **_k):
            raise OSError("down")

        urllib.request.urlopen = boom  # type: ignore[assignment]
        cut.time.sleep = lambda _s: None  # type: ignore[assignment]
        if cut.llm_moments(asset, 60.0, tr, spec, 5, [(0.0, 60.0)]) is not None:
            problems.append("model failure did not fall back")
    finally:
        urllib.request.urlopen = real  # type: ignore[assignment]
        cut.time.sleep = real_sleep  # type: ignore[assignment]
        os.environ.pop("OPENROUTER_API_KEY", None)
    log("selftest.llm", ok=not any("model" in p for p in problems))


# ---------------------------------------------------------------- every Look

THUMBS = HERE.parent / "public" / "looks"
LOOK_SECONDS = 9.0  # the moment every Look renders (hook-first: best line, then the body)
PAPER = tuple(int(L.DEFAULT_BRAND["paper"][i : i + 2], 16) for i in (1, 3, 5))


def synthetic_words(seconds: float) -> list[cut.Word]:
    """The selftest's script, a word every 0.45 s: captions have text to burn without whisper,
    and punch-in has sentence starts."""
    script = SPEECH.split()
    out = []
    t = 0.3
    i = 0
    while t < seconds - 0.4:
        out.append(cut.Word(round(t, 2), round(t + 0.35, 2), script[i % len(script)]))
        t += 0.45
        i += 1
    return out


def look_footage(dest: Path, seconds: int, pretty: bool) -> None:
    """Landscape test footage whose colours turn with time, so two moments of the same video look
    different (as real moments do). `pretty` (the thumbnails): her logo figure drifting over a
    moving gradient, never a real person; otherwise testsrc2, enough for every check."""
    audio = ["-f", "lavfi", "-i", f"aevalsrc='0.3*sin(2*PI*330*t)*lt(mod(t\\,6)\\,4.5)':s=48000:d={seconds}"]
    if pretty and L.LOGO.exists():
        cut.ffmpeg([
            "-f", "lavfi", "-i", f"gradients=s=1280x720:c0=0xF3E3C8:c1=0xC9A36B:c2=0x8F4B5B:nb_colors=3:speed=0.02:r=30:d={seconds}",
            "-loop", "1", "-i", str(L.LOGO), *audio,
            "-filter_complex", "[1:v]scale=-2:640[p];[0:v][p]overlay=x='(W-w)/2+110*sin(t/2.5)':y=50:shortest=1,hue=h='t*6',format=yuv420p[v]",
            "-map", "[v]", "-map", "2:a", "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(dest),
        ])
        return
    cut.ffmpeg(["-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={seconds}", *audio, "-t", str(seconds), "-vf", "hue=h='t*9'", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(dest)])


def band_diff(a: bytes, b: bytes, y0: int, y1: int, w: int = 54) -> float:
    """Mean absolute difference of two gray frames between rows y0..y1."""
    xs = [abs(a[i] - b[i]) for i in range(y0 * w, y1 * w)]
    return sum(xs) / max(1, len(xs))


def near_paper(px: tuple[int, int, int], tol: int = 14) -> bool:
    return all(abs(px[i] - PAPER[i]) <= tol for i in range(3))


def rgb_at(frame: bytes, x: int, y: int) -> tuple[int, int, int]:
    i = (y * L.OUT_W + x) * 3
    return frame[i], frame[i + 1], frame[i + 2]


def gutter_is_paper(frame: bytes, points: list[tuple[int, int]]) -> bool:
    """A gutter is paper-coloured at most of its points (the median): one pixel next to a sharp
    edge can carry the encoder's ringing (CI's x264, 26 Sep 2026)."""
    hits = sorted(near_paper(rgb_at(frame, x, y), tol=20) for x, y in points)
    return hits[len(hits) // 2]


def grid_problems(opts: dict, frame: bytes) -> list[str]:
    """Cell geometry from the pixels: the gutter between neighbouring cells is paper-coloured
    (sampled at five points along it) and the middle of every cell is footage, exactly where
    looks.json puts them."""
    out = []
    cells = L.cells_of(opts)
    gutter = L.FRAME["gutter"]
    along = (0.2, 0.35, 0.5, 0.65, 0.8)
    for x, y, w, h in cells:
        if near_paper(rgb_at(frame, x + w // 2, y + h // 2)) and near_paper(rgb_at(frame, x + w // 3, y + h // 3)):
            out.append(f"{opts['id']}: cell at {x},{y} shows no footage")
        right = x + w + gutter // 2
        if right < L.OUT_W and any(cx == x + w + gutter for cx, cy, _w, _h in cells if cy == y):
            if not gutter_is_paper(frame, [(right, y + int(h * f)) for f in along]):
                out.append(f"{opts['id']}: no gutter right of cell {x},{y}")
        below = y + h + gutter // 2
        if below < L.OUT_H and any(cy == y + h + gutter for cx, cy, _w, _h in cells if cx == x):
            if not gutter_is_paper(frame, [(x + int(w * f), below) for f in along]):
                out.append(f"{opts['id']}: no gutter under cell {x},{y}")
    return out


def check_looks(tmp: Path, problems: list[str], write_thumbs: bool) -> None:
    work = tmp / "looks"
    work.mkdir(parents=True, exist_ok=True)
    footage = work / "footage.mp4"
    look_footage(footage, 40, write_thumbs)
    info = cut.normalize(footage, work / "norm.mp4")
    words = synthetic_words(info["duration"])
    runs = [(float(a), min(info["duration"], a + 4.5)) for a in range(0, int(info["duration"]), 6)]
    tr = cut.Transcript(words=words, segments=[(0.0, info["duration"], "synthetic")], engine="synthetic")
    src = cut.Source(work / "norm.mp4", info, tr, runs, None)
    brand = L.Branding(handle="@samplestudio", cta="Follow for more real days")
    m = cut.Moment("ast_look", "hook_first", 2.0, 2.0 + LOOK_SECONDS - 2.0, [(8.0, 10.0), (2.0, 2.0 + LOOK_SECONDS - 2.0)], hook="You need to hear this part")
    libass = cut.ffmpeg_has_filter("subtitles")
    hashes: dict[str, list[int]] = {}
    kind = sys.argv[sys.argv.index("--looks-kind") + 1] if "--looks-kind" in sys.argv else "all"
    for lid in L.LOOK_IDS:
        opts = L.look_options(lid)
        # CI renders singles and grids in two parallel jobs (--looks-kind single|grid); a single and a
        # grid always differ (the grid's gutters are checked from the pixels), so each job compares its own.
        if kind != "all" and (opts["layout"] == "grid") != (kind == "grid"):
            continue
        cells, voice, ending = None, 0, None
        if opts["layout"] == "grid":
            # Studio fix: a grid's cells are the clip's own DIFFERENT shots (here: different stretches of
            # the footage), then the clip's hero full frame (never the same picture in two cells).
            gm = cut.Moment("ast_look", "montage", 0.0, 40.0, [(4.0 * i, 4.0 * i + 4.0) for i in range(len(L.cells_of(opts)))] + [(34.0, 37.0)])
            gm.part_keys = [f"ast_look@{4.0 * i:.2f}" for i in range(len(L.cells_of(opts)))] + ["ast_look@34.00"]
            gm.part_stages = ["process"] * len(L.cells_of(opts)) + ["hero"]
            gm.hero_asset_id, gm.hook = "ast_look", m.hook
            if not cut.look_fits(opts, gm, len(cut.grid_body(gm))):
                problems.append(f"{lid}: a grid of different shots was refused")
            cells, lay, ending = cut.grid_from_parts(gm, cut.grid_body(gm)[: len(L.cells_of(opts))], {"ast_look": src}, {}, False)
            if len(lay["cells"]) != len(L.cells_of(opts)) or len({(c["start"], c["end"]) for c in lay["cells"]}) != len(lay["cells"]) or not lay.get("ending"):
                problems.append(f"{lid}: grid cells are not all different shots with a hero ending")
        try:
            r = cut.render_moment(m, src, opts, brand, work, f"look_{lid}", False, cells=cells, voice=voice, ending=ending)
            # The comparison render: no words and no end call to action, so each one is measured.
            bare_opts = {**opts, "captions": "none", "hook": "none", "end_card": False}
            bare = cut.render_moment(m, src, bare_opts, brand, work, f"bare_{lid}", False, cells=cells, voice=voice, ending=ending)
        except subprocess.CalledProcessError:
            problems.append(f"{lid}: render failed")
            continue
        n = len(problems)
        got = cut.probe(r.mp4)
        if (got["width"], got["height"]) != (L.OUT_W, L.OUT_H):
            problems.append(f"{lid}: not 1080x1920")
        if abs(got["duration"] - r.duration) > 0.2 or not got["has_audio"]:
            problems.append(f"{lid}: duration {got['duration']:.2f} not {r.duration:.2f}")
        mid = r.duration / 2
        if libass:
            # 108x192 gray (every 10 px): the caption band is rows 139-158 at the bottom
            # (1390-1580 px) or 88-104 in the centre (880-1040 px); the hook band rows 15-33.
            f_look, f_bare = L.frame_gray(r.mp4, mid, 108, 192), L.frame_gray(bare.mp4, mid, 108, 192)
            y0, y1 = (88, 104) if opts["caption_position"] == "center" else (139, 158)
            d = band_diff(f_look, f_bare, y0, y1, 108)
            if opts["captions"] != "none" and d < 4:
                problems.append(f"{lid}: captions not burned ({d:.1f})")
            if opts["captions"] == "none" and d > 2:
                problems.append(f"{lid}: text burned where the look has none ({d:.1f})")
            # The hook is big and centred in the safe area (studio fix): rows around HOOK_Y.
            hy = L.HOOK_Y // 10
            h = band_diff(L.frame_gray(r.mp4, 1.0, 108, 192), L.frame_gray(bare.mp4, 1.0, 108, 192), hy - 8, hy + 8, 108)
            if (opts["hook"] == "top_bold") != (h >= 4):
                problems.append(f"{lid}: hook text {'missing' if opts['hook'] == 'top_bold' else 'burned'} ({h:.1f})")
        # Studio fix (owner, 23 Oct 2026: "every clip ending on a near-blank card"): the end is footage,
        # never a blank card, and (with libass) a big call to action sits in the safe area over it.
        end = L.frame_rgb(r.mp4, r.duration - 0.25)
        corners = [rgb_at(end, 40, 40), rgb_at(end, L.OUT_W - 40, L.OUT_H - 60), rgb_at(end, 40, L.OUT_H // 2)]
        if all(near_paper(px) for px in corners):
            problems.append(f"{lid}: ends on a blank card")
        if opts["end_card"] and libass:
            cy = L.CTA_Y // 10
            e = band_diff(L.frame_gray(r.mp4, r.duration - 0.25, 108, 192), L.frame_gray(bare.mp4, r.duration - 0.25, 108, 192), cy - 6, cy + 18, 108)
            if e < 4:
                problems.append(f"{lid}: no call to action on the end ({e:.1f})")
        if opts["layout"] == "grid":
            problems.extend(grid_problems(opts, L.frame_rgb(bare.mp4, mid)))  # text off: the gutters are bare
        hashes[lid] = [L.dhash(L.frame_gray(r.mp4, t, 55, 96)) for t in (1.0, mid, r.duration - 2.0)]
        if write_thumbs:
            THUMBS.mkdir(parents=True, exist_ok=True)
            L.contact_sheet(r.mp4, THUMBS / f"{lid}.webp", [1.0, mid, r.duration - 2.2])
        if len(problems) == n:
            log("selftest.look.ok", look=lid, seconds=round(got["duration"], 1), subtitles=r.subtitles)
    # every two Looks must look different: at one of three moments (the hook, the middle, near the
    # end) their frames must be far apart by difference hash (share of the 54x96 hash bits)
    ids = list(hashes)
    pairs = []
    bits = 54 * 96
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            pairs.append((max(bin(x ^ y).count("1") / bits for x, y in zip(hashes[a], hashes[b])), a, b))
    pairs.sort()
    for dist, a, b in pairs:
        if dist < LOOK_MIN_DISTANCE:
            problems.append(f"looks {a} and {b} look alike ({dist:.3f})")
    log("selftest.looks", looks=len(hashes), libass=libass, **{f"closest_{k + 1}": f"{a}/{b}={d:.3f}" for k, (d, a, b) in enumerate(pairs[:4])})
    wanted = [lid for lid in L.LOOK_IDS if kind == "all" or (L.LOOKS[lid]["layout"] == "grid") == (kind == "grid")]
    if not wanted or len(hashes) != len(wanted):
        problems.append("not every look rendered")


LOOK_MIN_DISTANCE = 0.02  # share of one frame's hash bits that must differ between any two Looks


# ---------------------------------------------------------------- another editor's videos (import mode)

def check_import(tmp: Path, problems: list[str]) -> None:
    """Her edit from CapCut (a tall video) replaces a clip; a connected editor's clips (one tall,
    one landscape) become a dump's clips. Every output is 1080x1920 without stretching, loudness
    near -14 LUFS, a cover, the length kept; the answer has the shape the Worker checks."""
    work = tmp / "import"
    work.mkdir(parents=True, exist_ok=True)
    src = work / "src"
    src.mkdir()
    make_sample(src / "tall.mp4", 8, "720x1280", None)
    make_sample(src / "wide.mp4", 12, "1280x720", None)
    out = work / "r2"

    def download(key: str, dest: Path) -> Path:
        shutil.copy(src / key, dest)
        return dest

    def fetch(url: str, dest: Path) -> Path:
        shutil.copy(src / url.rsplit("/", 1)[-1], dest)
        return dest

    def upload(path: Path, key: str, _ct: str) -> None:
        dst = out / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, dst)

    job = FakeJob()
    item = {"src": {"key": "tall.mp4"}, "clip_id": "clp_importhandbk", "asset_id": None, "title": None, "duration_s": None,
            "output_key": "clips/dmp_imp/clp_importhandbk-v1.mp4", "output_cover_key": "clips/dmp_imp/clp_importhandbk-v1.jpg", "platforms": ["tiktok"]}
    r = cut.import_items({"mode": "import", "replace": "clp_importhandbk", "editor": "capcut", "items": [item]}, work / "w1", download, upload, job.progress)
    rep = r.get("replaced") or {}
    if (rep.get("width"), rep.get("height")) != (720, 1280) or not 7.5 <= float(rep.get("duration_s") or 0) <= 8.5:
        problems.append("import: her edit was not measured")
    got = out / item["output_key"]
    if not got.exists() or not (out / item["output_cover_key"]).exists():
        problems.append("import: replacement not uploaded")
    else:
        info = cut.probe(got)
        lufs = loudness(got)
        if (info["width"], info["height"]) != (cut.OUT_W, cut.OUT_H) or lufs is None or not -17.5 <= lufs <= -10.5:
            problems.append("import: replacement not 1080x1920 at -14 LUFS")
    items = [
        {"src": {"url": "https://editor.example/out/tall.mp4"}, "clip_id": "clp_importeditra", "asset_id": "ast_imp", "title": "The part everyone asks about", "duration_s": 8,
         "output_key": "clips/dmp_imp/clp_importeditra.mp4", "output_cover_key": "clips/dmp_imp/clp_importeditra.jpg", "platforms": ["tiktok", "instagram", "youtube"]},
        {"src": {"url": "https://editor.example/out/wide.mp4"}, "clip_id": "clp_importeditrb", "asset_id": "ast_imp", "title": None, "duration_s": 12,
         "output_key": "clips/dmp_imp/clp_importeditrb.mp4", "output_cover_key": "clips/dmp_imp/clp_importeditrb.jpg", "platforms": ["tiktok", "instagram", "youtube"]},
    ]
    r = cut.import_items({"mode": "import", "replace": None, "editor": "opusclip", "items": items}, work / "w2", download, upload, job.progress, fetch=fetch)
    clips = r.get("clips") or []
    if len(clips) != 2 or any(set(c) != CLIP_KEYS for c in clips):
        problems.append("import: a connected editor's clips have the wrong shape")
    for c in clips:
        info = cut.probe(out / c["r2_key"])
        if (info["width"], info["height"]) != (cut.OUT_W, cut.OUT_H) or abs(info["duration"] - (c["end_s"] - c["start_s"])) > 0.3:
            problems.append("import: a connected editor's clip is not 1080x1920 or lost length")
    if clips and clips[0]["hook_text"] != "The part everyone asks about":
        problems.append("import: the editor's title was not kept as the hook")
    log("selftest.import", replaced=bool(rep), clips=len(clips))


# ---------------------------------------------------------------- her steering is honored (worker/domain/steer.ts)

def check_steer(tmp: Path, problems: list[str], heavy: dict) -> None:
    """What her chips and notes ask for is what the job makes: the note "2x4 grid, no music, fast"
    gives only 2x4 grids with punch-in and no song (even with songs uploaded); "Upbeat song, 2
    short clips" gives exactly 2 clips under 21 s with that song; leave-out / must-include are
    applied to the transcript, and what cannot be found is reported, never skipped silently."""
    work = tmp / "steer"
    work.mkdir(parents=True, exist_ok=True)
    src = work / "src"
    src.mkdir()
    make_sample(src / "wide.mp4", 40, "1280x720", None)
    cut.ffmpeg(["-f", "lavfi", "-i", "sine=frequency=660:duration=30:sample_rate=48000", str(src / "song.wav")])
    out = work / "r2"

    def download(key: str, dest: Path) -> Path:
        shutil.copy(src / ("song.wav" if key.startswith("music/") else key), dest)
        return dest

    def upload(path: Path, key: str, _ct: str) -> None:
        dst = out / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, dst)

    song = {"r2_key": "music/upl_selftestsong"}
    base = spec_for("new", "dmp_steer1", [{"id": "ast_steer", "r2_key": "wide.mp4", "allowed_platforms": ["tiktok", "instagram", "youtube"], "file_note": None}])
    grid = {**base, "rotation": ["grid_eight"], "looks": {"grid_eight": {"punch_in": True, "music": False}}, "music": [song], "target_clips": {"min": 3, "max": 3},
            "steer": {"rotation": ["grid_eight"], "count": None, "include": [], "avoid": [], "allowed_recipes": list(cut.RECIPE_ORDER)}}
    r = cut.cut_dump(grid, work / "w1", download, upload, FakeJob().progress, heavy)
    # Studio fix (owner, 23 Oct 2026: "Grid-of-four showing the same roses in 3 of 4 cells"): a grid is
    # made only from as many DIFFERENT shots as it has cells. One unseen video has no 8 different shots,
    # so the grid is skipped (a full-frame look instead) and she is told why, never a repeated picture.
    for c in r["clips"]:
        if c["look"] == "grid_eight":
            cells = (c["layout"] or {}).get("cells") or []
            if len(cells) != 8 or len({(x.get("asset_id"), x.get("start")) for x in cells}) != 8 or any(x.get("kind") != "part" for x in cells):
                problems.append("steer: a grid repeats a picture (cells are not 8 different shots)")
        elif L.LOOKS[c["look"]]["layout"] == "grid" or c["layout"]:
            problems.append("steer: another grid in place of the one she asked for")
        if c["music"] is not None:
            problems.append("steer: music under a clip after \"no music\"")
    if any(c["look"] != "grid_eight" for c in r["clips"]) and not any("different shots" in x.get("why", "") for x in r.get("steer_report") or []):
        problems.append("steer: the 2x4 grid she asked for was skipped without telling her why")
    short = {k: {"minS": 8, "maxS": min(v["maxS"], 20)} for k, v in cut.DEFAULT_RECIPES.items()}
    tune = {**base, "dump_id": "dmp_steer2", "output_prefix": "clips/dmp_steer2/", "rotation": ["clean"], "looks": {"clean": {"music": True}}, "music": [song], "recipes": short,
            "target_clips": {"min": 2, "max": 2}, "steer": {"rotation": ["clean"], "count": 2, "include": [], "avoid": [], "allowed_recipes": list(cut.RECIPE_ORDER)}}
    r = cut.cut_dump(tune, work / "w2", download, upload, FakeJob().progress, heavy)
    if len(r["clips"]) != 2:
        problems.append(f"steer: asked for 2 clips, made {len(r['clips'])}")
    for c in r["clips"]:
        if c["music"] != song["r2_key"]:
            problems.append("steer: the song she picked is not under the clip")
        if cut.probe(out / c["r2_key"])["duration"] > 21.5:
            problems.append("steer: a clip is longer than the short length she picked")
    # must include / leave out, on a known transcript (no whisper needed)
    words = [cut.Word(round(0.5 + i * 0.5, 2), round(0.9 + i * 0.5, 2), w) for i, w in enumerate(SPEECH.replace(".", "").split())]
    tr = cut.Transcript(words=words, segments=[(0.0, 60.0, "x")], engine="synthetic")
    end_at = next(w.start for w in words if w.text == "tomorrow")
    ms = [cut.Moment("ast_x", "talking_head", 0.0, 10.0, [(0.0, 10.0)]), cut.Moment("ast_x", "talking_head", end_at - 6, end_at + 3, [(end_at - 6, end_at + 3)])]
    st = {"avoid": ["try it tomorrow"], "include": ["three goals", "unicorn"], "allowed_recipes": ["talking_head"]}
    tight = {**cut.DEFAULT_RECIPES, "talking_head": {"minS": 8, "maxS": 12}}
    kept, told = cut.apply_steer(ms, {"id": "ast_x"}, tr, st, tight, 60.0)
    if any("tomorrow" in cut.moment_words(tr, m) for m in kept):
        problems.append("steer: a moment she asked to leave out was kept")
    if not any(getattr(m, "included", None) == "three goals" or "goals" in cut.moment_words(tr, m) for m in kept):
        problems.append("steer: a moment she asked to include is missing")
    if [x["what"] for x in told] != ['"unicorn"']:
        problems.append("steer: something she asked for that was never said was not reported")
    log("selftest.steer", grid_clips=len([1 for _ in r["clips"]]), reported=len(told))


def check_planned(tmp: Path, problems: list[str], heavy: dict) -> None:
    """Studio intelligence (layers 2 and 4) end to end on synthetic footage, with no model: the shot
    sheets come in the spec (as on a re-plan), one video BEFORE and one AFTER. The planner must make a
    before -> after clip that joins both videos, before first and the reveal last, rendered from each
    part's own video, with grounded words and the plain line sure. Then the 22 Oct live-test case:
    a test pattern nobody could read, camera sound off, must get a neutral hook ("Not sure")."""
    import see as V

    work = tmp / "planned"
    src = work / "src"
    src.mkdir(parents=True, exist_ok=True)
    # Distinct scenes (a different picture each), so "the same picture twice" is measurable.
    make_scene(src / "before.mp4", 8, "0xd8d0c4", (120, 300, 300, 500))
    make_scene(src / "prep.mp4", 8, "0x6f8fa8", (600, 200, 380, 900))
    make_scene(src / "team.mp4", 8, "0x8a6f5a", (100, 1200, 800, 500))
    make_scene(src / "process.mp4", 8, "0x4f7a52", (400, 700, 500, 300))
    make_sample(src / "after.mp4", 16, "720x1280", None)
    make_photo(src / "final-look.jpg", "0xc89b7b", (200, 400, 600, 900))
    out = work / "r2"

    def download(key: str, dest: Path) -> Path:
        shutil.copy(src / key, dest)
        return dest

    def upload(path: Path, key: str, _ct: str) -> None:
        dst = out / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(path, dst)

    services = ["alpha work", "beta work"]

    def one(aid: str, dur: float, *shots: V.Shot) -> dict:
        return V.ShotSheet(aid, dur, list(shots), "vision:selftest").to_json()

    sheets = {
        "ast_before": one("ast_before", 8.0, V.Shot(0.0, 8.0, what="an empty bare corner", subject="corner", state="before", service="unsure", confidence=0.9)),
        "ast_prep": one("ast_prep", 8.0, V.Shot(0.0, 8.0, what="boxes of supplies being unloaded", subject="supplies", state="in_progress", service="alpha work", confidence=0.9)),
        "ast_team": one("ast_team", 8.0, V.Shot(0.0, 8.0, what="two people doing the work", subject="team", state="in_progress", people="working", service="alpha work", confidence=0.9)),
        "ast_process": one("ast_process", 8.0, V.Shot(0.0, 8.0, what="the work being put together", subject="work", state="in_progress", service="alpha work", confidence=0.9)),
        "ast_photo": one("ast_photo", 6.0, V.Shot(0.0, 6.0, what="the finished corner, a photo", state="after", service="alpha work", confidence=0.9)),
        "ast_after": one("ast_after", 16.0, V.Shot(0.0, 8.0, what="the finished corner, wide", state="after", service="alpha work", confidence=0.9), V.Shot(8.0, 16.0, what="the finished corner, close", state="after", service="alpha work", confidence=0.9)),
    }
    all_p = ["tiktok", "instagram", "youtube"]
    names = {"ast_before": "before.mp4", "ast_prep": "prep.mp4", "ast_team": "team.mp4", "ast_process": "process.mp4", "ast_after": "after.mp4"}
    spec = spec_for("new", "dmp_planned", [{"id": aid, "r2_key": f, "mime_type": "video/mp4", "allowed_platforms": all_p, "file_note": None} for aid, f in names.items()]
                    + [{"id": "ast_photo", "r2_key": "final-look.jpg", "mime_type": "image/jpeg", "file_name": "final-look.jpg", "allowed_platforms": all_p, "file_note": None}])
    spec.update({"services": services, "shot_sheets": sheets, "camera": "off", "rotation": ["grid_four", "side_by_side", "clean"], "target_clips": {"min": 3, "max": 4},
                 "studio_rules": {"cta_phrases": ["Book your date", "Request a quote"], "cta_link": "https://example.com/request", "ai_note": "ai_images", "clip_target": {"min": 4, "max": 12}, "bar": 0, "place_words": ["Riverton"], "prices": False},
                 "brand_profile": {"ctas": "Book your beta work.\nMessage us to book your date.", "do_dont": "#SampleStudio"}})
    r = cut.cut_dump(spec, work / "w1", download, upload, FakeJob().progress, heavy)
    ll = r.get("looks_like") or {}
    if ll != {"service": "alpha work", "shape": "transformation", "camera": "off", "sure": True}:
        problems.append(f"planned: the plain line is wrong ({ll})")
    clips = r["clips"]
    # As many DISTINCT cuts as the footage holds, up to the studio's target (4..12 here). These six
    # uploads hold three (payoff-first, walk-in, moving photo); every other type would reuse most of
    # their shots, so fewer than 4 are made and she is told why.
    if not 3 <= len(clips) <= 12:
        problems.append(f"planned: {len(clips)} clips from footage that holds 3 distinct cuts (target 4..12)")
    if len(clips) < 4 and not any("different cuts" in x.get("why", "") for x in r.get("steer_report") or []):
        problems.append("planned: fewer clips than the target and she was not told why")
    trans = [c for c in clips if c.get("shape") == "transformation"]
    if not trans:
        problems.append("planned: no before -> after clip from a before video and an after video")
    for c in trans:
        pa = c.get("part_assets") or []
        # Payoff first (the playbook): a flash of the finished result, then the before, ending on the reveal.
        if len(pa) < 3 or pa[1] != "ast_before" or c["parts"][0][1] - c["parts"][0][0] > 1.6 or pa[-1] != c["hero_asset_id"]:
            problems.append("planned: a before -> after clip does not flash the payoff, show the before, and end on the reveal")
        if c["asset_id"] != pa[-1]:
            problems.append("planned: a joined clip's video is not the reveal's")
    grids = [c for c in clips if c["layout"]]
    if not grids:
        problems.append("planned: clips of different shots made no grid (side by side or four)")
    for c in grids:
        cells = c["layout"]["cells"]
        if len({x["asset_id"] for x in cells}) != len(cells) or not c["layout"].get("ending"):
            problems.append("planned: a grid repeats a picture or has no hero ending")
    for c in clips:
        if not c["hero_asset_id"] or (c.get("part_assets") or [c["asset_id"]])[-1] != c["hero_asset_id"] or c["parts"][-1][1] - c["parts"][-1][0] < 1.99:
            problems.append("planned: a clip does not end on its hero, held 2 s")
        if not c["layout"]:
            want = sum(e - s for s, e in c["parts"])
            got = cut.probe(out / c["r2_key"])["duration"]
            if abs(got - want) > 2.5:
                problems.append(f"planned: a joined clip plays {got:.1f}s, its parts add to {want:.1f}s")
        if c.get("shape") != "transformation" and "ast_before" in (c.get("part_assets") or [c["asset_id"]]):
            problems.append("planned: a before shot is in a clip that is not a before -> after")
        text = " ".join([c["hook_text"], c.get("hook_alt") or "", c["caption"]]).lower()
        if "beta" in text or "automatic" in text:
            problems.append("planned: a clip's words name another service or mention automation")
        if not c.get("on_screen"):
            problems.append("planned: a clip does not say what is on screen (the voice over needs it)")
        if c["uses_ai_images"] != ("ast_photo" in c["files_used"]):
            problems.append("planned: a photo with no camera EXIF is not marked as an AI picture (or a video is)")
    sigs = [frozenset((pa, round(p[0], 1)) for pa, p in zip(c.get("part_assets") or [c["asset_id"]] * len(c["parts"]), c["parts"][:-1])) for c in clips]
    for i in range(len(sigs)):
        for j in range(i):
            if sigs[i] and sigs[j] and len(sigs[i] & sigs[j]) / min(len(sigs[i]), len(sigs[j])) >= 0.5:
                problems.append("planned: two clips share most of their shots")
    if r.get("asset_roles", {}).get("ast_photo") != "hero":
        problems.append("planned: a photo named final is not the hero")
    if (r.get("clip_counts") or {}).get("distinct") != len([c for c in clips if not c["hidden_reason"]]):
        problems.append("planned: clip_counts do not count the distinct clips")
    if r.get("calls", {}).get("vision", 0) != 0:
        problems.append("planned: saved shot sheets were looked at again")

    # Nobody could look (no key, no local model) and the camera sound is off: neutral words only.
    blind = spec_for("new", "dmp_blind", [{"id": "ast_blind", "r2_key": "after.mp4", "allowed_platforms": all_p, "file_note": None}])
    blind.update({"services": services, "camera": "off", "rotation": ["clean"], "target_clips": {"min": 1, "max": 2}, "notes": "Empty corner? Watch it glow up! alpha work",
                  "brand_profile": {"ctas": "Book your alpha work."}})
    r2 = cut.cut_dump(blind, work / "w2", download, upload, FakeJob().progress, heavy)
    if (r2.get("looks_like") or {}).get("sure"):
        problems.append("planned: a video nobody could read was called sure")
    for c in r2["clips"]:
        t = c["hook_text"].lower()
        if any(w in t for w in ("empty", "glow", "alpha", "beta")):
            problems.append("planned: an unsure clip's hook guessed what it shows")
    log("selftest.planned", clips=len(r["clips"]), transformation=len(trans), blind=len(r2["clips"]))


def check_protect(tmp: Path, problems: list[str], samples: Path, heavy: dict[str, bool]) -> None:
    """Layer 5 in the cut's own environment (23 Oct 2026: on the live runner the face finder failed and a
    blur pass died, so a client's clips were all hidden): a frame with a face and a house number must
    come back with both found and blurred, the finders must load, and the blur must render."""
    import protect as PR
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1080, 1920), (235, 235, 230))
    portrait = samples / "portrait.jpg"
    if portrait.exists():
        face = Image.open(portrait).convert("RGB")
        face = face.resize((600, int(face.height * 600 / face.width)))
        img.paste(face, (240, 200))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 220)
    except OSError:
        font = ImageFont.load_default(size=220)
    d.rectangle([260, 1380, 820, 1700], fill=(255, 255, 255), outline=(0, 0, 0), width=8)
    d.text((300, 1420), "4521", fill=(0, 0, 0), font=font)
    still = tmp / "protect.png"
    img.save(still)
    src = tmp / "protect.mp4"
    cut.ffmpeg(["-loop", "1", "-i", str(still), "-t", "3", "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(src)])
    info = cut.probe(src)
    log("selftest.protect.video", seconds=round(info["duration"], 2), width=info["width"], height=info["height"])
    finder = cut.mp_faces(heavy["mediapipe"])
    log("selftest.protect.finders", faces_on_still=len(finder(img)) if finder else -1, numbers_on_still=len(PR.numbers_with_text(img)))
    rules = PR.rules_from({"content_rules": {"blockFaces": True, "blockAddresses": True, "ownerFace": "show"}})
    out, ok, boxes = PR.protect_video(src, info, rules, None, tmp, "selftest", cut.mp_faces(heavy["mediapipe"]))
    if not ok:
        problems.append("protect: the face or number finder did not run in the cut's environment")
    if boxes < (2 if portrait.exists() else 1):
        problems.append(f"protect: found {boxes} things to blur, expected a face and a house number")
    if out == src or not Path(out).exists() or cut.probe(Path(out))["duration"] < 2.5:
        problems.append("protect: the blurred video was not made")
    log("selftest.protect", ok=ok, boxes=boxes)


def main() -> int:
    write_fixture = "--write-fixture" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="cut-selftest-"))
    problems: list[str] = []
    check_llm(problems)
    try:
        samples = tmp / "samples"
        samples.mkdir()
        speech = samples / "speech.wav"
        has_speech = speech_track(speech)
        make_sample(samples / "wide.mp4", 60, "1280x540", "1280:720", speech if has_speech else None)  # landscape with black bars
        make_sample(samples / "tall.mp4", 40, "720x1280", None)
        out = tmp / "r2"

        def download(key: str, dest: Path) -> Path:
            shutil.copy(samples / key, dest)
            return dest

        def upload(src: Path, key: str, _ct: str) -> None:
            dst = out / key
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(src, dst)

        log("selftest.tools", speech=has_speech, libass=cut.ffmpeg_has_filter("subtitles"))
        heavy = cut.ensure_heavy()  # installs only with JOB_HEAVY=1 (CI); locally uses what is importable
        face = bool(cut.face_detector(heavy["mediapipe"]))
        log("selftest.heavy", whisper=heavy["whisper"], mediapipe=heavy["mediapipe"], face_detector=face)
        if "--require-heavy" in sys.argv:
            # CI: the real tools must all be there, or the run proves nothing about production.
            for name, ok in (("whisper", heavy["whisper"]), ("libass", cut.ffmpeg_has_filter("subtitles")), ("speech", has_speech)):
                if not ok:
                    problems.append(f"required tool missing: {name}")
            if heavy["mediapipe"] and not face:
                problems.append("mediapipe installed but the face detector did not load")
        if face:
            # A public MediaPipe sample portrait placed left of centre in a landscape frame:
            # the 9:16 crop must follow the face, not the frame centre.
            try:
                import urllib.request

                with urllib.request.urlopen("https://storage.googleapis.com/mediapipe-assets/portrait.jpg", timeout=60) as res:
                    (samples / "portrait.jpg").write_bytes(res.read())
                cut.ffmpeg([
                    "-f", "lavfi", "-i", "color=c=gray:s=1920x1080:d=3:r=30", "-loop", "1", "-i", str(samples / "portrait.jpg"),
                    "-filter_complex", "[1:v]scale=-2:1000[p];[0:v][p]overlay=200:40:shortest=1,format=yuv420p",
                    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", str(samples / "face.mp4"),
                ])
                cx = cut.face_center(samples / "face.mp4", 0, 2.5, True)
                expected = (200 + 1000 * 820 / 1024 / 2) / 1920
                if cx is None or abs(cx - expected) > 0.05:
                    problems.append("face crop did not follow the face")
                log("selftest.face", found=cx is not None, off=round(abs((cx or 0) - expected), 3))
            except OSError:
                log("selftest.face.sample_unreachable")
        write_thumbs = "--write-thumbs" in sys.argv
        if "--require-heavy" in sys.argv or "--require-libass" in sys.argv or write_thumbs:
            if not cut.ffmpeg_has_filter("subtitles"):
                problems.append("looks need libass to prove burned captions")
        if "--skip-looks" not in sys.argv:
            check_looks(tmp, problems, write_thumbs)
        if "--looks-only" not in sys.argv and "--require-heavy" in sys.argv:
            check_protect(tmp, problems, samples, heavy)
        if "--looks-only" not in sys.argv:
            check_import(tmp, problems)
            check_steer(tmp, problems, heavy)
            check_planned(tmp, problems, heavy)
        all_platforms = ["tiktok", "instagram", "youtube"]
        runs = [] if "--looks-only" in sys.argv else [
            spec_for("new", "dmp_selftestnew", [{"id": "ast_selftestwide", "r2_key": "wide.mp4", "allowed_platforms": all_platforms, "file_note": None}]),
            spec_for("recycle", "dmp_selftestold", [{"id": "ast_selftesttall", "r2_key": "tall.mp4", "allowed_platforms": ["instagram", "youtube"], "file_note": None}]),
        ]
        fixture_result = None
        for spec in runs:
            job = FakeJob()
            result = cut.cut_dump(spec, tmp / f"work_{spec['door']}", download, upload, job.progress, heavy)
            seen = {s for s, _d, _t in job.steps}
            if seen != STAGES:
                problems.append(f"progress stages missing: {sorted(STAGES - seen)}")
            for key in ("transcript", "picker", "crop", "subtitles"):
                if not result.get("engine", {}).get(key):
                    problems.append(f"engine.{key} not reported")
            if spec["door"] == "new" and has_speech and heavy["whisper"]:
                if result["engine"]["transcript"] != "faster-whisper":
                    problems.append("whisper installed but no transcript")
                if result["engine"]["subtitles"] not in ("burned", "soft"):
                    problems.append("speech but no word subtitles")
                if "--require-heavy" in sys.argv and result["engine"]["subtitles"] != "burned":
                    problems.append("libass present but subtitles were not burned")
            if spec["door"] == "recycle" and any(c["platforms"] != ["instagram", "youtube"] for c in result["clips"]):
                problems.append("recycle clip ignored the allowed platforms")
            check(result, spec, out, problems)
            used = {c["look"] for c in result["clips"]}
            if len(result["clips"]) >= 3 and len(used) < 3:
                problems.append(f"{spec['door']}: {len(result['clips'])} clips but only {len(used)} looks")
            # Studio fix: a grid only from the clip's own DIFFERENT shots (never a repeated picture). This
            # dump is unseen speech-picked footage with no distinct shots, so no grid at all.
            if any(c["layout"] for c in result["clips"]):
                problems.append("a grid look on footage without enough different shots (a repeated picture)")
            log("selftest.run", door=spec["door"], clips=len(result["clips"]), looks=len(used), transcript=result["engine"]["transcript"], picker=result["engine"]["picker"], crop=result["engine"]["crop"], subtitles=result["engine"]["subtitles"])
            if spec["door"] == "new":
                fixture_result = {"dump_id": spec["dump_id"], "assets": [{"id": a["id"], "r2_key": f"raw/{spec['dump_id']}/{a['id']}", "allowed_platforms": a["allowed_platforms"]} for a in spec["assets"]], "result": result}
        if write_fixture and fixture_result and not problems:
            FIXTURE.parent.mkdir(parents=True, exist_ok=True)
            FIXTURE.write_text(json.dumps(fixture_result, indent=2) + "\n", encoding="utf-8")
            log("selftest.fixture.written")
    finally:
        if "--keep" in sys.argv:  # --keep <dir>: copy the rendered clips out for a look
            shutil.copytree(tmp / "r2", Path(sys.argv[sys.argv.index("--keep") + 1]), dirs_exist_ok=True)
        shutil.rmtree(tmp, ignore_errors=True)
    for p in problems:
        log("selftest.problem", detail=re.sub(r"\s+", "_", p)[:40])
    log("selftest.done", ok=not problems, problems=len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
