"""Scenario comic strips from the game's own art (CLAUDE.md "Decide by drawing
scenario comics first").

A panel is a small native-resolution SCENE built from the theme's real tiles,
props and character frames, scaled up by an integer factor with
nearest-neighbour (so the pixel grid stays honest), then lettered at full
resolution: caption boxes, balloons, sound effects, and a TODAY / PROPOSED tag
that says whether the panel shows the current build or a mock of an idea.

Everything is deterministic (seeded RNG for dust and debris), so re-running a
strip reproduces it byte for byte.

    from comic import Scene, Panel, Strip
    s = Scene(288, 200, art)            # native px; 64px tiles, 96px characters
    s.floor('floor'); s.wall_band(0, 1)
    s.char('vine-ranger', 'e', x=80, y=170)
    p = Panel(s, scale=2, tag='PROPOSED', caption='...')
    Strip('A', 'Quickdraw', [p, ...]).render().save('a.png')

Fonts: Press Start 2P and VT323 (SIL OFL, fonts/OFL.txt).
"""

from __future__ import annotations

import math
import random
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "assets"))
from palette import PALETTE  # noqa: E402  (the locked pack palette)

FONT_TITLE = str(HERE / "fonts" / "PressStart2P-Regular.ttf")
FONT_TEXT = str(HERE / "fonts" / "VT323-Regular.ttf")

# Named palette entries (all from the locked PALETTE).
INK = "#08080c"
NIGHT = "#141a16"
PLUM = "#1c1420"
TEAL_D, TEAL, TEAL_M, TEAL_L, TEAL_XL = "#163a3e", "#24565c", "#3a7a80", "#5aa4ae", "#7ecbd2"
TAN_D, TAN, TAN_L = "#4a3419", "#8f6c38", "#cbb277"
MET_D, MET, MET_M, MET_L, MET_XL = "#23282e", "#3c444d", "#59636d", "#7b8791", "#a2adb4"
BIO, BIO_L, CYAN, GOLD, ORANGE, RED, VIOLET = "#46e078", "#a6ffbe", "#3ce0d8", "#ffd83e", "#ff9032", "#e04a2a", "#a05ae0"
SKIN, PAPER = "#d8a878", "#f2f6ea"
assert all(c in PALETTE for c in (INK, NIGHT, PLUM, TEAL, GOLD, ORANGE, PAPER, BIO, MET_L, TAN_L, RED))


def rgba(hexstr: str, a: int = 255) -> tuple[int, int, int, int]:
    h = hexstr.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


# ---------------------------------------------------------------------------
# Art


class Art:
    """The theme pack, read from a git ref (default: the animation ship branch)
    or a checked-out theme directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[str, Image.Image] = {}

    @classmethod
    def from_ref(cls, repo: Path, ref: str, cache: Path) -> "Art":
        theme = "public/themes/swampspace-hires"
        sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", ref], text=True).strip()[:12]
        dest = cache / sha
        if not (dest / theme).exists():
            dest.mkdir(parents=True, exist_ok=True)
            tar = subprocess.Popen(["git", "-C", str(repo), "archive", ref, theme], stdout=subprocess.PIPE)
            subprocess.run(["tar", "-x", "-C", str(dest)], stdin=tar.stdout, check=True)
            tar.wait()
        return cls(dest / theme)

    def img(self, rel: str) -> Image.Image:
        if rel not in self._cache:
            self._cache[rel] = Image.open(self.root / rel).convert("RGBA")
        return self._cache[rel]

    def char(self, kind: str, d: str = "e", state: str = "idle", i: int | None = None) -> Image.Image:
        """A character frame; west-facing dirs mirror the east art as the game does."""
        mirror = d in ("w", "nw", "sw")
        src = {"w": "e", "nw": "ne", "sw": "se"}.get(d, d)
        name = f"chars/{kind}-{src}-{state}" + (f"-{i}" if i is not None else "") + ".png"
        im = self.img(name)
        return ImageOps.mirror(im) if mirror else im

    def tile(self, kind: str, v: int = 0) -> Image.Image:
        return self.img(f"tiles/{kind}-{v}.png")


# ---------------------------------------------------------------------------
# Sprite transforms


def tint(im: Image.Image, color: str, amount: float = 1.0) -> Image.Image:
    """Recolour toward `color`, keeping alpha (hit flash, silhouettes)."""
    solid = Image.new("RGBA", im.size, rgba(color))
    solid.putalpha(im.getchannel("A"))
    return Image.blend(im, solid, amount)


def fade(im: Image.Image, alpha: float) -> Image.Image:
    out = im.copy()
    out.putalpha(im.getchannel("A").point(lambda a: int(a * alpha)))
    return out


def feet(im: Image.Image) -> tuple[int, int]:
    """Feet anchor in image coords: horizontal centre of the canvas, bottom of
    the drawn pixels (the game anchors characters at (0.5, 1))."""
    bb = im.getbbox() or (0, 0, im.width, im.height)
    return (im.width // 2, bb[3])


def centre(im: Image.Image) -> tuple[int, int]:
    bb = im.getbbox() or (0, 0, im.width, im.height)
    return ((bb[0] + bb[2]) // 2, (bb[1] + bb[3]) // 2)


def transform(im: Image.Image, pivot: tuple[int, int], rot: float = 0, sx: float = 1, sy: float = 1,
              flip: bool = False) -> tuple[Image.Image, tuple[int, int]]:
    """Mirror, scale and rotate (degrees, clockwise on screen) around `pivot`.
    Returns the new image and where the pivot landed in it. Nearest-neighbour
    throughout: this is exactly what a render-only transform does in game."""
    px, py = pivot
    if flip:
        im = ImageOps.mirror(im)
        px = im.width - 1 - px
    if sx != 1 or sy != 1:
        w, h = max(1, round(im.width * abs(sx))), max(1, round(im.height * abs(sy)))
        im = im.resize((w, h), Image.NEAREST)
        px, py = round(px * abs(sx)), round(py * abs(sy))
    if rot:
        r = math.ceil(max(math.hypot(px - cx, py - cy) for cx in (0, im.width) for cy in (0, im.height))) + 2
        pad = Image.new("RGBA", (2 * r, 2 * r))
        pad.alpha_composite(im, (r - px, r - py))
        im = pad.rotate(-rot, resample=Image.NEAREST)
        px, py = r, r
    return im, (px, py)


# ---------------------------------------------------------------------------
# Scene (native resolution)


class Scene:
    def __init__(self, w: int, h: int, art: Art, bg: str = NIGHT, seed: int = 7) -> None:
        self.w, self.h, self.art = w, h, art
        self.im = Image.new("RGBA", (w, h), rgba(bg))
        self.rng = random.Random(seed)

    # -- ground ------------------------------------------------------------
    def floor(self, kind: str, rect: tuple[int, int, int, int] | None = None, variants: int = 1,
              ox: int = 0, oy: int = 0) -> None:
        """Tile `kind` over rect (native px, default whole scene), grid offset ox/oy."""
        x0, y0, x1, y1 = rect or (0, 0, self.w, self.h)
        layer = Image.new("RGBA", (self.w, self.h))
        for ty in range(y0 + oy - 64, y1, 64):
            for tx in range(x0 + ox - 64, x1, 64):
                v = ((tx * 7 + ty * 13) // 64) % variants
                t = self.art.tile(kind, abs(v))
                layer.paste(t, (tx, ty), t)
        mask = Image.new("L", (self.w, self.h), 0)
        ImageDraw.Draw(mask).rectangle((x0, y0, x1 - 1, y1 - 1), fill=255)
        self.im.paste(layer, (0, 0), ImageChops.multiply(mask, layer.getchannel("A")))

    def wall_band(self, y: int, rows: int = 1, x0: int = 0, x1: int | None = None) -> None:
        """A north wall: `rows` tiles of wall face with the cap along its top edge,
        and the contact shadow the floor gets under it."""
        x1 = self.w if x1 is None else x1
        self.floor("wall", (x0, y, x1, y + 64 * rows), variants=3, ox=(-x0) % 64)
        cap = self.art.img("tiles/wall-cap.png")
        for tx in range(x0, x1, 64):
            self.im.alpha_composite(cap.crop((0, 0, min(64, x1 - tx), 64)), (tx, y))
        sh = Image.new("RGBA", (self.w, self.h))
        d = ImageDraw.Draw(sh)
        for i in range(6):
            d.line((x0, y + 64 * rows + i, x1, y + 64 * rows + i), fill=rgba(INK, 120 - i * 20))
        self.im.alpha_composite(sh)

    def prop(self, name: str, x: int, y: int, scale: float = 1) -> None:
        im = self.art.img(f"props/{name}.png")
        self.put(im, x, y, sx=scale, sy=scale)

    # -- bodies --------------------------------------------------------------
    def shadow(self, x: int, y: int, rx: int = 18, ry: int = 5, a: int = 110) -> None:
        sh = Image.new("RGBA", (self.w, self.h))
        ImageDraw.Draw(sh).ellipse((x - rx, y - ry, x + rx, y + ry), fill=rgba(INK, a))
        self.im.alpha_composite(sh)

    def put(self, im: Image.Image, x: int, y: int, *, pivot: str | tuple[int, int] = "feet", rot: float = 0,
            sx: float = 1, sy: float = 1, flip: bool = False, alpha: float = 1, color: str | None = None,
            color_amt: float = 1.0, outline: str | None = None) -> None:
        """Draw `im` with its pivot ('feet', 'centre' or image px) at scene (x, y)."""
        pv = feet(im) if pivot == "feet" else centre(im) if pivot == "centre" else pivot
        out, (px, py) = transform(im, pv, rot, sx, sy, flip)
        if color:
            out = tint(out, color, color_amt)
        if outline:
            ring = Image.new("RGBA", out.size, rgba(outline))
            ring.putalpha(out.getchannel("A").point(lambda a: 255 if a > 40 else 0).filter(ImageFilter.MaxFilter(3)))
            ring.alpha_composite(out)
            out = ring
        if alpha < 1:
            out = fade(out, alpha)
        layer = Image.new("RGBA", (self.w, self.h))
        layer.paste(out, (x - px, y - py), out)
        self.im.alpha_composite(layer)

    def char(self, kind: str, d: str, x: int, y: int, state: str = "idle", i: int | None = None,
             shadow: bool = True, **kw) -> Image.Image:
        im = self.art.char(kind, d, state, i)
        if shadow:
            self.shadow(x, y, rx=max(10, (im.getbbox() or (0, 0, 40, 0))[2] // 4))
        self.put(im, x, y, **kw)
        return im

    def ghosts(self, im: Image.Image, poses: list[dict], color: str = TEAL_XL) -> None:
        """Afterimages: earlier poses as fading tinted silhouettes (a smear)."""
        n = len(poses)
        for k, p in enumerate(poses):
            self.put(im, color=color, color_amt=0.45, alpha=0.45 + 0.3 * (k + 1) / (n + 1), outline=PAPER, **p)

    # -- effects -------------------------------------------------------------
    def lines(self, segs: list[tuple[float, float, float, float]], color: str = PAPER, width: int = 1,
              a: int = 255) -> None:
        d = ImageDraw.Draw(self.im)
        for s in segs:
            d.line(s, fill=rgba(color, a), width=width)

    def speed_lines(self, x: float, y: float, ang: float, n: int = 5, length: int = 26, spread: int = 22,
                    color: str = PAPER) -> None:
        """Motion lines trailing BEHIND a body moving along `ang` (degrees, 0 = east)."""
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        for k in range(n):
            off = (k - (n - 1) / 2) * spread / max(1, n - 1)
            back = 10 + self.rng.randint(0, 10)
            ln = length * (0.6 + 0.4 * self.rng.random())
            bx, by = x - ca * back - sa * off, y - sa * back + ca * off
            self.lines([(bx, by, bx - ca * ln, by - sa * ln)], color=color)

    def burst(self, x: float, y: float, r_in: float, r_out: float, n: int = 10, fill: str = GOLD,
              edge: str = INK, rot: float = 0) -> None:
        pts = []
        for k in range(2 * n):
            r = r_out * (0.75 + 0.25 * self.rng.random()) if k % 2 == 0 else r_in
            a = math.radians(rot + k * 180 / n)
            pts.append((x + r * math.cos(a), y + r * math.sin(a)))
        d = ImageDraw.Draw(self.im)
        d.polygon(pts, fill=rgba(fill), outline=rgba(edge))

    def dust(self, x: float, y: float, n: int = 6, spread: float = 14, size: int = 4, color: str = TAN_L,
             a: int = 200) -> None:
        d = ImageDraw.Draw(self.im)
        for _ in range(n):
            cx, cy = x + self.rng.uniform(-spread, spread), y + self.rng.uniform(-spread / 3, spread / 4)
            r = self.rng.randint(max(1, size - 2), size + 1)
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=rgba(color, a), outline=rgba(TAN, a))

    def smoke(self, x: float, y: float, n: int = 5, drift: tuple[float, float] = (0, -10), size: int = 6) -> None:
        d = ImageDraw.Draw(self.im)
        for k in range(n):
            cx, cy = x + drift[0] * k / n + self.rng.uniform(-3, 3), y + drift[1] * k / n
            r = size - k // 2 + self.rng.randint(0, 2)
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=rgba(MET_M if k % 2 else MET_L, 190 - k * 25))

    def sparks(self, x: float, y: float, n: int = 8, length: int = 10, color: str = GOLD, ang: float = 0,
               cone: float = 360) -> None:
        d = ImageDraw.Draw(self.im)
        for _ in range(n):
            a = math.radians(ang + self.rng.uniform(-cone / 2, cone / 2))
            l0, l1 = self.rng.uniform(2, 5), self.rng.uniform(length * 0.5, length)
            d.line((x + math.cos(a) * l0, y + math.sin(a) * l0, x + math.cos(a) * l1, y + math.sin(a) * l1),
                   fill=rgba(color), width=1)

    def fx(self, name: str, x: int, y: int, scale: float = 1, rot: float = 0, alpha: float = 1) -> None:
        self.put(self.art.img(f"fx/{name}.png"), x, y, pivot="centre", sx=scale, sy=scale, rot=rot, alpha=alpha)

    def bolt(self, x0: float, y0: float, x1: float, y1: float, color: str = BIO) -> None:
        """A spore bolt in flight with its glow trail."""
        d = ImageDraw.Draw(self.im)
        d.line((x0, y0, x1, y1), fill=rgba(color, 150), width=3)
        d.line((x0, y0, x1, y1), fill=rgba(BIO_L), width=1)
        d.ellipse((x1 - 3, y1 - 3, x1 + 3, y1 + 3), fill=rgba(BIO_L), outline=rgba(color))

    def dashed(self, pts: list[tuple[float, float]], color: str = PAPER, dash: int = 4, gap: int = 4,
               a: int = 220) -> None:
        d = ImageDraw.Draw(self.im)
        carry = 0.0
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            seg = math.hypot(xb - xa, yb - ya)
            t = -carry
            while t < seg:
                s0, s1 = max(0.0, t), min(seg, t + dash)
                if s1 > s0:
                    d.line((xa + (xb - xa) * s0 / seg, ya + (yb - ya) * s0 / seg,
                            xa + (xb - xa) * s1 / seg, ya + (yb - ya) * s1 / seg), fill=rgba(color, a))
                t += dash + gap
            carry = t - seg

    def gun(self, x: int, y: int, ang: float = 0, flip: bool = False) -> None:
        """A hand-sized spore pistol (grip at x, y), pixelled at native res."""
        g = Image.new("RGBA", (22, 9))
        d = ImageDraw.Draw(g)
        d.rectangle((3, 1, 19, 4), fill=rgba(MET), outline=rgba(INK))
        d.rectangle((4, 2, 18, 2), fill=rgba(MET_XL))
        d.rectangle((3, 4, 7, 8), fill=rgba(MET_D), outline=rgba(INK))
        d.point((20, 2), fill=rgba(BIO))
        d.point((21, 2), fill=rgba(BIO_L))
        self.put(g, x, y, pivot=(5, 4), rot=ang, flip=flip)

    def vignette(self, strength: int = 120) -> None:
        mask = Image.new("L", (self.w, self.h), 0)
        ImageDraw.Draw(mask).rectangle((0, 0, self.w, self.h), fill=strength)
        inner = Image.new("L", (self.w, self.h), 0)
        m = min(self.w, self.h) // 6
        ImageDraw.Draw(inner).rounded_rectangle((m, m, self.w - m, self.h - m), radius=m, fill=strength)
        mask = ImageChops.subtract(mask, inner.filter(ImageFilter.GaussianBlur(m)))
        dark = Image.new("RGBA", (self.w, self.h), rgba(INK))
        dark.putalpha(mask)
        self.im.alpha_composite(dark)


# ---------------------------------------------------------------------------
# Lettering (full resolution)


@dataclass
class Caption:
    text: str
    pos: str = "tl"  # tl | tr | bl | br | top | bottom
    color: str = PAPER
    ink: str = INK


@dataclass
class Balloon:
    text: str
    x: float  # box centre, fraction of panel width
    y: float
    tail: tuple[float, float]  # tail tip, fraction of panel
    shout: bool = False


@dataclass
class Sfx:
    text: str
    x: float
    y: float
    size: int = 32
    rot: float = -8
    fill: str = GOLD
    edge: str = INK


@dataclass
class Label:
    """A small annotation (callout) in VT323, with an optional leader line."""
    text: str
    x: float
    y: float
    to: tuple[float, float] | None = None
    color: str = PAPER
    size: int = 24
    bg: str | None = INK


def wrap(text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    out: list[str] = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            trial = f"{line} {word}".strip()
            if f.getlength(trial) <= width or not line:
                line = trial
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


@dataclass
class Panel:
    scene: Scene | Image.Image
    scale: int = 2
    tag: str | None = None  # 'TODAY' | 'PROPOSED' | 'IN FLIGHT' | None
    caption: Caption | str | None = None
    caption2: Caption | str | None = None
    balloons: list[Balloon] = field(default_factory=list)
    sfx: list[Sfx] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)
    span: int = 1

    def art(self) -> Image.Image:
        im = self.scene.im if isinstance(self.scene, Scene) else self.scene
        return im.resize((im.width * self.scale, im.height * self.scale), Image.NEAREST)

    def render(self, w: int, h: int) -> Image.Image:
        art = self.art()
        out = Image.new("RGBA", (w, h), rgba(NIGHT))
        out.alpha_composite(art.crop(((art.width - w) // 2, (art.height - h) // 2,
                                      (art.width - w) // 2 + w, (art.height - h) // 2 + h)))
        for lab in self.labels:
            _label(out, lab)
        for b in self.balloons:
            _balloon(out, b)
        for s in self.sfx:
            _sfx(out, s)
        for c in (self.caption, self.caption2):
            if c:
                _caption(out, c if isinstance(c, Caption) else Caption(c))
        if self.tag:
            _tag(out, self.tag)
        return out


def _caption(out: Image.Image, c: Caption) -> None:
    f = font(FONT_TEXT, 26)
    w = out.width
    maxw = int(w * ({"top": 0.74, "bottom": 0.96}.get(c.pos, 0.62)))
    lines = wrap(c.text, f, maxw - 20)
    lh = 24
    bw = max(int(f.getlength(ln)) for ln in lines) + 22
    bh = lh * len(lines) + 14
    x = 10 if c.pos in ("tl", "bl", "top", "bottom") else w - bw - 10
    y = 10 if c.pos in ("tl", "tr", "top") else out.height - bh - 10
    d = ImageDraw.Draw(out)
    d.rectangle((x + 4, y + 4, x + bw + 4, y + bh + 4), fill=rgba(INK, 160))
    d.rectangle((x, y, x + bw, y + bh), fill=rgba(c.color), outline=rgba(INK), width=3)
    for k, ln in enumerate(lines):
        d.text((x + 11, y + 5 + k * lh), ln, font=f, fill=rgba(c.ink))


TAG_COLORS = {"TODAY": (MET_L, INK), "PROPOSED": (ORANGE, INK), "IN FLIGHT": (TEAL_XL, INK), "IDEA": (VIOLET, PAPER)}


def _tag(out: Image.Image, tag: str) -> None:
    f = font(FONT_TITLE, 12)
    bg, ink = TAG_COLORS.get(tag, (GOLD, INK))
    tw = int(f.getlength(tag)) + 16
    x, y = out.width - tw - 10, 10
    d = ImageDraw.Draw(out)
    d.rectangle((x, y, x + tw, y + 22), fill=rgba(bg), outline=rgba(INK), width=2)
    d.text((x + 8, y + 5), tag, font=f, fill=rgba(ink))


def _balloon(out: Image.Image, b: Balloon) -> None:
    f = font(FONT_TEXT, 28)
    lines = wrap(b.text, f, int(out.width * 0.42))
    lh = 26
    tw = max(int(f.getlength(ln)) for ln in lines)
    bw, bh = tw + 36, lh * len(lines) + 22
    cx, cy = b.x * out.width, b.y * out.height
    x0, y0 = cx - bw / 2, cy - bh / 2
    tx, ty = b.tail[0] * out.width, b.tail[1] * out.height
    d = ImageDraw.Draw(out)
    base = 12
    # the tail leaves the box edge nearest the tip
    ex, ey = max(x0 + 18, min(x0 + bw - 18, tx)), (y0 + bh - 2 if ty > cy else y0 + 2)
    tail = [(ex - base, ey), (ex + base, ey), (tx, ty)]
    if b.shout:
        pts = []
        rng = random.Random(hash(b.text) & 0xFFFF)
        for k in range(28):
            a = 2 * math.pi * k / 28
            r = 1.18 if k % 2 == 0 else 1.0
            r += rng.uniform(0, 0.08)
            pts.append((cx + math.cos(a) * bw / 2 * r * 1.08, cy + math.sin(a) * bh / 2 * r * 1.25))
        d.polygon(pts, fill=rgba(PAPER), outline=rgba(INK))
        d.polygon(tail, fill=rgba(PAPER), outline=rgba(INK))
        d.polygon(pts, fill=rgba(PAPER))
    else:
        d.polygon(tail, fill=rgba(PAPER), outline=rgba(INK), width=3)
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=16, fill=rgba(PAPER), outline=rgba(INK), width=3)
        d.line((tail[0][0] + 3, ey, tail[1][0] - 3, ey), fill=rgba(PAPER), width=4)
    for k, ln in enumerate(lines):
        lw = f.getlength(ln)
        d.text((cx - lw / 2, y0 + 9 + k * lh), ln, font=f, fill=rgba(INK))


def _sfx(out: Image.Image, s: Sfx) -> None:
    f = font(FONT_TITLE, s.size)
    tw = int(f.getlength(s.text)) + 24
    th = s.size + 24
    layer = Image.new("RGBA", (tw, th))
    d = ImageDraw.Draw(layer)
    d.text((12, 12), s.text, font=f, fill=rgba(s.fill), stroke_width=max(3, s.size // 8), stroke_fill=rgba(s.edge))
    layer = layer.rotate(-s.rot, resample=Image.NEAREST, expand=True)
    out.alpha_composite(layer, (int(s.x * out.width - layer.width / 2), int(s.y * out.height - layer.height / 2)))


def _label(out: Image.Image, lab: Label) -> None:
    f = font(FONT_TEXT, lab.size)
    lines = lab.text.split("\n")
    lh = lab.size - 2
    tw = max(int(f.getlength(ln)) for ln in lines)
    x, y = lab.x * out.width, lab.y * out.height
    d = ImageDraw.Draw(out)
    if lab.to:
        tx, ty = lab.to[0] * out.width, lab.to[1] * out.height
        d.line((x, y, tx, ty), fill=rgba(INK), width=5)
        d.line((x, y, tx, ty), fill=rgba(lab.color), width=2)
        d.ellipse((tx - 4, ty - 4, tx + 4, ty + 4), fill=rgba(lab.color), outline=rgba(INK))
    bx, by = x - tw / 2 - 6, y - (lh * len(lines)) / 2 - 4
    if lab.bg:
        d.rectangle((bx, by, bx + tw + 12, by + lh * len(lines) + 8), fill=rgba(lab.bg, 225), outline=rgba(lab.color))
    for k, ln in enumerate(lines):
        d.text((x - f.getlength(ln) / 2, by + 3 + k * lh), ln, font=f, fill=rgba(lab.color))


# ---------------------------------------------------------------------------
# Strip


@dataclass
class Strip:
    key: str
    title: str
    subtitle: str
    rows: list[list[Panel]]
    panel_w: int = 576
    panel_h: int = 400
    footer: str = "TODAY = the current build.  PROPOSED = a mock of the idea, not a screenshot."

    def render(self) -> Image.Image:
        g, border, head = 22, 5, 104
        cols = max(sum(p.span for p in row) for row in self.rows)
        W = g + cols * (self.panel_w + g)
        H = head + len(self.rows) * (self.panel_h + g) + 44
        out = Image.new("RGBA", (W, H), rgba(PLUM))
        d = ImageDraw.Draw(out)
        # header: a key plate and the title
        ft, fs = font(FONT_TITLE, 28), font(FONT_TEXT, 30)
        d.rectangle((g, 22, g + 56, 78), fill=rgba(BIO), outline=rgba(INK), width=3)
        d.text((g + 15, 36), self.key, font=ft, fill=rgba(INK))
        d.text((g + 76, 26), self.title.upper(), font=ft, fill=rgba(PAPER), stroke_width=2, stroke_fill=rgba(INK))
        d.text((g + 78, 62), self.subtitle, font=fs, fill=rgba(TEAL_XL))
        y = head
        for row in self.rows:
            used = sum(p.span for p in row)
            x = g + (cols - used) * (self.panel_w + g) // 2
            for p in row:
                pw = p.span * self.panel_w + (p.span - 1) * g
                im = p.render(pw, self.panel_h)
                d.rectangle((x - border, y - border, x + pw + border - 1, y + self.panel_h + border - 1),
                            fill=rgba(PAPER))
                d.rectangle((x - 2, y - 2, x + pw + 1, y + self.panel_h + 1), fill=rgba(INK))
                out.alpha_composite(im, (x, y))
                x += pw + g
            y += self.panel_h + g
        d.text((g, H - 36), self.footer, font=font(FONT_TEXT, 24), fill=rgba(MET_L))
        sig = "sporefall station / animation scenarios"
        d.text((W - g - font(FONT_TEXT, 24).getlength(sig), H - 36), sig, font=font(FONT_TEXT, 24), fill=rgba(MET_M))
        return out


def zoom_sheet(paths: list[Path], out: Path, factor: int = 3, crop: int = 900) -> None:
    """3x nearest crops of each strip's top-left area, for the by-eye review."""
    tiles = []
    for p in paths:
        im = Image.open(p)
        c = im.crop((0, 0, min(crop, im.width), min(crop * 2 // 3, im.height)))
        tiles.append(c.resize((c.width * factor // 2, c.height * factor // 2), Image.NEAREST))
    W = max(t.width for t in tiles)
    sheet = Image.new("RGBA", (W, sum(t.height for t in tiles)), rgba(PLUM))
    y = 0
    for t in tiles:
        sheet.alpha_composite(t.convert("RGBA"), (0, y))
        y += t.height
    sheet.save(out)
