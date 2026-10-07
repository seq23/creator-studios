"""Render one clip in one Look (jobs/looks.json). Used by jobs/cut.py for every clip of a dump and
for a single-clip re-render, and by jobs/selftest_cut.py to render every Look.

A Look is a set of options: caption style (clean / karaoke / boxed / none) and position, the bold
hook at the top, a layout (fill = face-follow 9:16 crop; blur_fill = the whole frame over a blurred
copy; pip = a small inset replaying the strongest line; grid = several moments tiled, one of them
the voice), motion (punch-in on sentence starts, a progress bar, crossfades), a warm grade, her
end card (logo + handle, last 1.5 s) and a music bed from her own uploaded songs.

Everything is ffmpeg (+ libass for burned text). Low-resolution sources (the owner's test videos
were 320x568 to 576x1024) are upscaled with lanczos and a light sharpen, never stretched: every
crop keeps the source's aspect ratio and fills its cell. Logs carry counts only.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "looks.json").read_text(encoding="utf-8"))
FRAME = DATA["frame"]
OUT_W, OUT_H = FRAME["w"], FRAME["h"]
FPS = 30
LOOKS: dict[str, dict[str, Any]] = {l["id"]: l for l in DATA["looks"]}
LOOK_IDS: list[str] = [l["id"] for l in DATA["looks"]]
GRIDS: dict[str, dict[str, Any]] = DATA["grids"]
DEFAULT_BRAND: dict[str, str] = DATA["defaults"]["brand"]
DEFAULT_FONT: str = DATA["defaults"]["font"]
LOGO = HERE.parent / "public" / "assets" / "brand" / "studio-mark.png"
OPTION_KEYS = ("captions", "caption_position", "hook", "layout", "grid", "punch_in", "progress_bar", "crossfade", "grade", "end_card")
HOOK_SECONDS = 2.5
CARD_SECONDS = 1.5
FADE = 0.35

# Brand fonts a Brand Profile may name, fetched from Google Fonts' public repo at render time.
# Anything else (or no network) uses the default font; the look never fails on a font.
FONT_URLS = {
    "montserrat": "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "playfair display": "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf",
    "poppins": "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf",
    "inter": "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    "lato": "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf",
    "open sans": "https://github.com/google/fonts/raw/main/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf",
}


def look_options(look_id: str, override: dict[str, Any] | None = None) -> dict[str, Any]:
    """The options for a Look: the Worker's resolved copy when it sent one (her Settings switches
    applied), else looks.json. Unknown ids fall back to Clean."""
    base = LOOKS.get(look_id) or LOOKS["clean"]
    out = {k: base[k] for k in OPTION_KEYS}
    out["id"] = base["id"]
    out["music"] = False
    for k, v in (override or {}).items():
        if k in OPTION_KEYS or k == "music":
            out[k] = v
    if out["layout"] == "grid" and out.get("grid") not in GRIDS:
        out["layout"], out["grid"] = "fill", None
    return out


def cells_of(opts: dict[str, Any]) -> list[list[int]]:
    return GRIDS[opts["grid"]]["cells"] if opts["layout"] == "grid" else [[0, 0, OUT_W, OUT_H]]


# ---------------------------------------------------------------- branding

@dataclass
class Branding:
    primary: str = DEFAULT_BRAND["primary"]
    ink: str = DEFAULT_BRAND["ink"]
    paper: str = DEFAULT_BRAND["paper"]
    accent: str = DEFAULT_BRAND["accent"]
    font: str = DEFAULT_FONT
    handle: str = ""
    cta: str = ""
    fontsdir: Path | None = None
    logo: Path | None = field(default_factory=lambda: LOGO if LOGO.exists() else None)


HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def branding_from(spec_branding: dict[str, Any] | None, work: Path) -> Branding:
    b = Branding()
    sb = spec_branding or {}
    for k in ("primary", "ink", "paper", "accent"):
        v = str((sb.get("colors") or {}).get(k) or "")
        if HEX.match(v):
            setattr(b, k, v.lower())
    b.handle = re.sub(r"[^A-Za-z0-9._@]", "", str(sb.get("handle") or ""))[:30]
    if b.handle and not b.handle.startswith("@"):
        b.handle = "@" + b.handle
    b.cta = str(sb.get("cta") or "")[:60]
    font = str(sb.get("font") or "").strip()
    if font and font.lower() in FONT_URLS:
        path = ensure_font(font.lower(), work / "fonts")
        if path:
            b.font, b.fontsdir = font.title() if font.lower() != "playfair display" else "Playfair Display", path.parent
    return b


def ensure_font(name: str, folder: Path) -> Path | None:
    url = FONT_URLS.get(name)
    if not url:
        return None
    dest = folder / (re.sub(r"[^a-z]", "", name) + ".ttf")
    if dest.exists():
        return dest
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=20) as res:
            dest.write_bytes(res.read())
        return dest
    except Exception:  # noqa: BLE001
        return None


def ass_color(hex_rgb: str, alpha: int = 0) -> str:
    """#rrggbb -> ASS &HAABBGGRR (alpha 0 = opaque)."""
    h = hex_rgb.lstrip("#")
    return f"&H{alpha:02X}{h[4:6]}{h[2:4]}{h[0:2]}".upper().replace("&H", "&H", 1)


def ff_color(hex_rgb: str) -> str:
    return "0x" + hex_rgb.lstrip("#").upper()


# ---------------------------------------------------------------- sources

@dataclass
class Seg:
    """One stretch of a normalized source video: what a part, a cell or the inset shows."""

    path: Path
    start: float
    end: float
    width: int
    height: int
    bars: tuple[int, int, int, int] | None = None
    cx: float | None = None
    zoom: float = 1.0

    @property
    def dur(self) -> float:
        return max(0.1, self.end - self.start)


def even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


def crop_to(seg: Seg, out_w: int, out_h: int) -> str:
    """Crop the source to the target's aspect ratio around the face (or the centre), then scale.
    Never stretches. Upscaling uses lanczos plus a light sharpen (low-res phone footage);
    downscaling uses area."""
    bx, by, bw, bh = 0, 0, seg.width, seg.height
    if seg.bars:
        w, h, x, y = seg.bars
        if w >= seg.width * 0.5 and h >= seg.height * 0.5:
            bw, bh, bx, by = w, h, x, y
    aspect = out_w / out_h
    cw = min(bw, bh * aspect)
    ch = min(bh, cw / aspect)
    z = max(1.0, seg.zoom)
    cw, ch = even(cw / z), even(ch / z)
    centre = seg.cx if seg.cx is not None else 0.5
    x = int(min(max(bx, bx + centre * bw - cw / 2), bx + bw - cw))
    y = int(by + (bh - ch) * (0.4 if z > 1 else 0.5))
    up = out_w / max(1, cw)
    flags = "lanczos" if up > 1 else "area"
    sharpen = ",unsharp=5:5:0.6:5:5:0.0" if up >= 1.8 else ""
    return f"crop={cw}:{ch}:{x}:{y},scale={out_w}:{out_h}:flags={flags}{sharpen},setsar=1"


# ---------------------------------------------------------------- captions (ASS)

@dataclass
class Word:
    start: float
    end: float
    text: str


def ass_time(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def ass_text(s: str) -> str:
    return s.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_ass(words: list[Word], hook: str, opts: dict[str, Any], b: Branding, dur: float, card: bool) -> str | None:
    """The burned text for one clip in one Look: word captions, the hook, the end card's handle.
    None when there is nothing to burn."""
    style = opts["captions"]
    centre = opts["caption_position"] == "center"
    until = dur - CARD_SECONDS if card else dur
    white, black = "&H00FFFFFF", "&H00000000"
    prim, ink, paper = ass_color(b.primary), ass_color(b.ink), ass_color(b.paper)
    align, margin = (5, 0) if centre else (2, 380)
    fmt = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"
    f = b.font
    styles = {
        "clean": f"Style: Sub,{f},{80 if centre else 74},{white},{white},{black},&H64000000,-1,0,0,0,100,100,0,0,1,4,2,{align},90,90,{margin},1",
        "karaoke": f"Style: Sub,{f},{92 if centre else 84},{white},{white},{black},&H78000000,-1,0,0,0,100,100,0,0,1,5,3,{align},80,80,{margin},1",
        "boxed": f"Style: Sub,{f},{72 if centre else 76},{ink},{ink},{prim},{prim},-1,0,0,0,100,100,0,0,3,14,0,{align},90,90,{margin},1",
    }
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {OUT_W}", f"PlayResY: {OUT_H}", "WrapStyle: 0", "", "[V4+ Styles]", fmt]
    lines.append(styles.get(style, styles["clean"]))
    lines.append(f"Style: Hook,{f},88,{ink},{white},{prim},{prim},-1,0,0,0,100,100,0,0,3,20,0,8,70,70,190,1")
    lines.append(f"Style: Card,{f},66,{ink},{ink},{paper},{paper},-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1")
    lines.append(f"Style: Cta,{f},44,{ass_color(b.accent)},{ink},{paper},{paper},0,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1")
    lines += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    n = 0
    if opts["hook"] == "top_bold" and hook:
        lines.append(f"Dialogue: 2,{ass_time(0)},{ass_time(min(HOOK_SECONDS, until))},Hook,,0,0,0,,{ass_text(hook)}")
        n += 1
    if style != "none":
        size = {"clean": 4, "karaoke": 3, "boxed": 3}.get(style, 3)
        spoken = [w for w in words if w.start < until]
        chunks = [spoken[i : i + size] for i in range(0, len(spoken), size)]
        for ci, chunk in enumerate(chunks):
            nxt = chunks[ci + 1][0].start if ci + 1 < len(chunks) else chunk[-1].end + 0.3
            if style == "clean":
                s, e = chunk[0].start, min(until, max(chunk[-1].end, min(nxt, chunk[-1].end + 0.4)))
                if e - s >= 0.05:
                    lines.append(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{ass_text(' '.join(w.text for w in chunk))}")
                    n += 1
                continue
            for j, w in enumerate(chunk):
                end = min(until, chunk[j + 1].start if j + 1 < len(chunk) else w.end)
                if end - w.start < 0.05:
                    end = min(until, w.start + 0.05)
                if end <= w.start:
                    continue
                parts = []
                for k, x in enumerate(chunk):
                    if k != j:
                        parts.append(ass_text(x.text))
                    elif style == "karaoke":
                        parts.append(f"{{\\c{prim}&\\fscx112\\fscy112}}{ass_text(x.text)}{{\\r}}")
                    else:
                        parts.append(f"{{\\c{paper}&}}{ass_text(x.text)}{{\\r}}")
                lines.append(f"Dialogue: 0,{ass_time(w.start)},{ass_time(end)},Sub,,0,0,0,,{' '.join(parts)}")
                n += 1
    if card:
        s = dur - CARD_SECONDS + 0.2
        if b.handle:
            lines.append(f"Dialogue: 3,{ass_time(s)},{ass_time(dur)},Card,,0,0,0,,{{\\pos(540,1150)\\fad(250,0)}}{ass_text(b.handle)}")
            n += 1
        if b.cta:
            lines.append(f"Dialogue: 3,{ass_time(s)},{ass_time(dur)},Cta,,0,0,0,,{{\\pos(540,1250)\\fad(250,0)}}{ass_text(b.cta)}")
            n += 1
    return "\n".join(lines) + "\n" if n else None


def build_srt(words: list[Word], hook: str, dur: float) -> str:
    """Soft subtitles when this ffmpeg has no libass (local machines only; CI requires libass)."""

    def ts(t: float) -> str:
        ms = int(round(max(0.0, t) * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

    cues: list[tuple[float, float, str]] = [(0.0, min(HOOK_SECONDS, dur), hook)] if hook else []
    for i in range(0, len(words), 3):
        ch = words[i : i + 3]
        cues.append((ch[0].start, ch[-1].end, " ".join(w.text for w in ch)))
    return "".join(f"{n}\n{ts(s)} --> {ts(e)}\n{t}\n\n" for n, (s, e, t) in enumerate(cues, 1))


# ---------------------------------------------------------------- motion

def sentence_starts(words: list[Word], dur: float) -> list[float]:
    """Where a new sentence starts (after punctuation or a pause); every 3.5 s without words."""
    if not words:
        return [round(t, 2) for t in [x * 3.5 for x in range(1, int(dur // 3.5) + 1)] if t < dur - 1]
    out = [words[0].start]
    for prev, w in zip(words, words[1:]):
        if prev.text.rstrip().endswith((".", "!", "?")) or w.start - prev.end > 0.5:
            out.append(w.start)
    return [round(t, 2) for t in out if t < dur - 0.5][:16]


def punch_expr(starts: list[float], dur: float, amount: float = 0.07) -> str:
    """zoompan z: every other sentence punches in (eased over 0.15 s) and holds until the next."""
    terms = []
    for i in range(0, len(starts), 2):
        a = starts[i]
        b = starts[i + 1] if i + 1 < len(starts) else dur
        terms.append(f"between(in_time,{a:.2f},{b:.2f})*min(1,(in_time-{a:.2f})/0.15)")
    return f"1+{amount}*({'+'.join(terms)})" if terms else "1"


# ---------------------------------------------------------------- the render

def sh(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout, check=True)


def ffmpeg(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    return sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], cwd=cwd, timeout=timeout)


_FILTERS: set[str] | None = None


def has_filter(name: str) -> bool:
    global _FILTERS
    if _FILTERS is None:
        out = sh(["ffmpeg", "-hide_banner", "-filters"]).stdout
        _FILTERS = {p[1] for p in (l.split() for l in out.splitlines()) if len(p) >= 3}
    return name in _FILTERS


def output_duration(opts: dict[str, Any], parts: list[Seg]) -> float:
    if opts["layout"] == "grid":
        return parts[0].dur
    total = sum(p.dur for p in parts)
    if opts["crossfade"] and len(parts) > 1:
        total -= FADE * (len(parts) - 1)
    return round(total, 3)


def timeline_words(words_by_part: list[list[Word]], parts: list[Seg], opts: dict[str, Any]) -> list[Word]:
    """Source-time words of each part mapped onto the output timeline (crossfades overlap parts)."""
    out: list[Word] = []
    offset = 0.0
    overlap = FADE if opts["crossfade"] and len(parts) > 1 and opts["layout"] != "grid" else 0.0
    for k, (seg, ws) in enumerate(zip(parts, words_by_part)):
        for w in ws:
            out.append(Word(round(w.start - seg.start + offset, 3), round(w.end - seg.start + offset, 3), w.text))
        offset += seg.dur - overlap
        if opts["layout"] == "grid":
            break
    return out


@dataclass
class Rendered:
    mp4: Path
    cover: Path
    subtitles: str  # burned | soft | hook-only | none
    duration: float
    music_used: bool = False  # a song from her uploads is mixed under the voice


def render_look(
    opts: dict[str, Any],
    parts: list[Seg],
    words: list[Word],
    hook: str,
    brand: Branding,
    work: Path,
    name: str,
    *,
    cells: list[Seg] | None = None,
    voice: int = 0,
    inset: Seg | None = None,
    music: Path | None = None,
) -> Rendered:
    """One clip in one Look. `parts` are the moment's stretches in order (a hook-first clip has the
    best line, then the body). A grid Look uses `cells` (cell `voice` plays its sound and is
    where `words` come from); a pip Look uses `inset`."""
    out = work / f"{name}.mp4"
    cover = work / f"{name}.jpg"
    grid = opts["layout"] == "grid" and cells
    if grid:
        parts = [cells[voice]]
    dur = output_duration(opts, parts)
    card = bool(opts["end_card"]) and dur >= 4.0
    args: list[str] = []
    chains: list[str] = []
    n_in = 0

    def add(seg_args: list[str]) -> int:
        nonlocal n_in
        args.extend(seg_args)
        n_in += 1
        return n_in - 1

    def seg_input(seg: Seg) -> int:
        return add(["-ss", f"{seg.start:.3f}", "-t", f"{seg.dur:.3f}", "-i", str(seg.path.resolve())])

    paper = ff_color(brand.paper)
    if grid:
        chains.append(f"color=c={paper}:s={OUT_W}x{OUT_H}:r={FPS}:d={dur:.3f}[g0]")
        geo = cells_of(opts)
        last = "g0"
        for j, (seg, (x, y, w, h)) in enumerate(zip(cells, geo)):
            i = seg_input(seg)
            chains.append(
                f"[{i}:v]{crop_to(seg, w, h)},fps={FPS},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={dur:.3f},"
                f"trim=duration={dur:.3f},drawbox=x=0:y=0:w=iw:h=ih:color=black@0.16:t=3[c{j}]"
            )
            chains.append(f"[{last}][c{j}]overlay={x}:{y}:eof_action=pass[g{j + 1}]")
            last = f"g{j + 1}"
            if j == voice:
                chains.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={dur:.3f}[ac]")
        v = last
    else:
        for k, seg in enumerate(parts):
            i = seg_input(seg)
            if opts["layout"] == "blur_fill":
                bars = seg.bars if seg.bars and seg.bars[0] >= seg.width * 0.5 and seg.bars[1] >= seg.height * 0.5 else None
                pre = f"crop={bars[0]}:{bars[1]}:{bars[2]}:{bars[3]}," if bars else ""
                chains.append(
                    f"[{i}:v]{pre}split=2[bi{k}][fi{k}];"
                    f"[bi{k}]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase:flags=bilinear,crop={OUT_W}:{OUT_H},gblur=sigma=40,eq=brightness=-0.06:saturation=0.85[bg{k}];"
                    f"[fi{k}]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease:flags=lanczos[fg{k}];"
                    f"[bg{k}][fg{k}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={FPS},format=yuv420p,setpts=PTS-STARTPTS[v{k}]"
                )
            else:
                chains.append(f"[{i}:v]{crop_to(seg, OUT_W, OUT_H)},fps={FPS},format=yuv420p,setpts=PTS-STARTPTS[v{k}]")
            chains.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{k}]")
        n = len(parts)
        if n == 1:
            chains.append("[v0]null[vj];[a0]anull[ac]")
        elif opts["crossfade"]:
            vprev, aprev, off = "v0", "a0", 0.0
            for k in range(1, n):
                off += parts[k - 1].dur - FADE
                vl, al = (f"xv{k}", f"xa{k}") if k < n - 1 else ("vj", "ac")
                chains.append(f"[{vprev}][v{k}]xfade=transition=fade:duration={FADE}:offset={off:.3f}[{vl}]")
                chains.append(f"[{aprev}][a{k}]acrossfade=d={FADE}[{al}]")
                vprev, aprev = vl, al
        else:
            chains.append("".join(f"[v{k}][a{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=1[vj][ac]")
        v = "vj"
        if opts["grade"] == "warm":
            chains.append(f"[{v}]eq=contrast=1.05:saturation=1.08,colorbalance=rs=0.05:gs=0.01:bs=-0.05,vignette=angle=PI/5[vg]")
            v = "vg"
        if opts["crossfade"]:
            chains.append(f"[{v}]fade=t=in:st=0:d=0.4[vf]")
            v = "vf"
        if opts["punch_in"]:
            z = punch_expr(sentence_starts(words, dur), dur)
            chains.append(f"[{v}]zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={OUT_W}x{OUT_H}:fps={FPS}[vz]")
            v = "vz"
        if opts["layout"] == "pip" and inset is not None:
            i = seg_input(inset)
            frames = max(1, int(inset.dur * FPS))
            chains.append(
                f"[{i}:v]{crop_to(inset, 324, 576)},fps={FPS},setpts=PTS-STARTPTS,loop=loop=-1:size={frames}:start=0,setpts=N/{FPS}/TB,"
                f"trim=duration={dur:.3f},pad=w=iw+12:h=ih+12:x=6:y=6:color={ff_color(brand.primary)}[pip]"
            )
            hook_until = HOOK_SECONDS if opts["hook"] == "top_bold" and hook else 0.0
            chains.append(f"[{v}][pip]overlay=x=W-w-36:y=330:enable='gte(t,{hook_until:.2f})'[vp]")
            v = "vp"
    if grid and opts["grade"] == "warm":
        chains.append(f"[{v}]eq=contrast=1.05:saturation=1.08,colorbalance=rs=0.05:gs=0.01:bs=-0.05[vg]")
        v = "vg"
    if opts["progress_bar"]:
        chains.append(f"color=c={ff_color(brand.primary)}:s={OUT_W}x12:r={FPS}:d={dur:.3f}[pb]")
        chains.append(f"[{v}][pb]overlay=x='-w+w*t/{dur:.3f}':y=H-h:eof_action=pass[vb]")
        v = "vb"
    if card:
        chains.append(f"color=c={paper}:s={OUT_W}x{OUT_H}:r={FPS}:d={dur:.3f}[k0]")
        k = "k0"
        if brand.logo:
            li = add(["-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(brand.logo.resolve())])
            chains.append(f"[{li}:v]scale=-2:620:flags=lanczos,format=rgba[logo]")
            chains.append(f"[k0][logo]overlay=(W-w)/2:360:shortest=1[k1]")
            k = "k1"
        st = dur - CARD_SECONDS
        chains.append(f"[{k}]format=yuva420p,fade=t=in:st={st:.3f}:d=0.35:alpha=1[card]")
        chains.append(f"[{v}][card]overlay=0:0:enable='gte(t,{st:.3f})':eof_action=pass[vk]")
        v = "vk"
    # Burned text last, so captions, the hook and the handle sit on top of everything.
    subs = "none"
    sub_map: list[str] = []
    ass = build_ass(words, hook, opts, brand, dur, card)
    if ass is not None and has_filter("subtitles"):
        (work / f"{name}.ass").write_text(ass, encoding="utf-8")
        fonts = f":fontsdir={brand.fontsdir.resolve()}" if brand.fontsdir else ""
        chains.append(f"[{v}]subtitles={name}.ass{fonts}[vs]")
        v = "vs"
        subs = "burned" if opts["captions"] != "none" and words else "hook-only"
    elif ass is not None:
        (work / f"{name}.srt").write_text(build_srt(words if opts["captions"] != "none" else [], hook if opts["hook"] != "none" else "", dur), encoding="utf-8")
        si = add(["-i", f"{name}.srt"])
        sub_map = ["-map", f"{si}:s", "-c:s", "mov_text"]
        subs = "soft"
    # Audio: her voice, a music bed from her own songs ducked under it, then -14 LUFS.
    a = "ac"
    music_used = music is not None and music.exists()
    if music_used:
        mi = add(["-stream_loop", "-1", "-i", str(music.resolve())])
        chains.append(
            f"[{mi}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={dur:.3f},volume=0.22,"
            f"afade=t=in:d=0.8,afade=t=out:st={max(0.0, dur - 1.5):.3f}:d=1.5[mb]"
        )
        chains.append("[ac]asplit=2[vo1][vo2]")
        chains.append("[mb][vo2]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[duck]")
        chains.append("[vo1][duck]amix=inputs=2:duration=first:normalize=0[am]")
        a = "am"
    chains.append(f"[{a}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,atrim=duration={dur:.3f}[ao]")
    chains.append(f"[{v}]trim=duration={dur:.3f},format=yuv420p[vo]")
    ffmpeg(
        [
            *args,
            "-filter_complex", ";".join(chains),
            "-map", "[vo]", "-map", "[ao]", *sub_map,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
            "-movflags", "+faststart", out.name,
        ],
        cwd=work,
    )
    ffmpeg(["-ss", f"{min(1.0, dur / 3):.2f}", "-i", out.name, "-frames:v", "1", "-q:v", "3", cover.name], cwd=work)
    return Rendered(out, cover, subs, dur, music_used)


def frame_gray(path: Path, t: float, w: int = 54, h: int = 96) -> bytes:
    """One frame as w*h grayscale bytes (the selftest's perceptual hash and caption checks)."""
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True, timeout=120,
    ).stdout


def frame_rgb(path: Path, t: float) -> bytes:
    """One full-size frame as RGB24 bytes (grid geometry checks)."""
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True, timeout=120,
    ).stdout


def ahash(gray: bytes) -> int:
    """Average hash over a grayscale frame: bit set where a pixel is brighter than the mean."""
    mean = sum(gray) / max(1, len(gray))
    bits = 0
    for i, p in enumerate(gray):
        if p > mean:
            bits |= 1 << i
    return bits


def dhash(gray: bytes, w: int = 55, h: int = 96) -> int:
    """Difference hash over a (w x h) grayscale frame: one bit per horizontal neighbour pair, set
    where the left pixel is brighter. Edges (text strokes, cell borders, zoom) flip bits; flat
    colour does not. (w-1)*h bits."""
    bits = 0
    k = 0
    for y in range(h):
        row = y * w
        for x in range(w - 1):
            if gray[row + x] > gray[row + x + 1]:
                bits |= 1 << k
            k += 1
    return bits


def contact_sheet(mp4: Path, dest: Path, times: list[float]) -> None:
    """A 3-frame strip (the Look thumbnails in public/looks/, made once from the selftest footage)."""
    sel = "+".join(f"between(t,{t:.2f},{t + 0.04:.2f})" for t in times)
    ffmpeg(["-i", str(mp4), "-vf", f"select='{sel}',scale=144:256:flags=area,tile=3x1:padding=4:color=0xF7F1E7", "-frames:v", "1", "-fps_mode", "vfr", "-c:v", "libwebp", "-quality", "70", str(dest)])


if os.environ.get("LOOKS_SELFCHECK") == "1":  # pragma: no cover - quick syntax/data sanity
    assert set(LOOK_IDS) and all(l["layout"] != "grid" or l["grid"] in GRIDS for l in DATA["looks"])
