"""The animation-scenario strips (board: sporefall-animation-scenarios).

    python3 scripts/comics/strips.py [OUT_DIR] [--ref origin/ship/actions-1106] [--only A,B]

Each strip_X() returns a comic.Strip; main() renders them to OUT_DIR/<key>.png
(default /mnt/d/tmp/cast-walks/comics). Art comes from the animation ship
branch so the panels show the frames that are about to ship.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

from comic import (BIO, BIO_L, CYAN, GOLD, INK, MET, MET_D, MET_L, MET_M, MET_XL, NIGHT, ORANGE, PAPER, PLUM, RED,
                   TAN, TAN_D, TAN_L, TEAL, TEAL_D, TEAL_L, TEAL_M, TEAL_XL, VIOLET, Art, Balloon, Caption, Label,
                   Panel, Scene, Sfx, Strip, rgba, font, FONT_TEXT, FONT_TITLE)

REPO = Path(__file__).resolve().parents[2]
ART: Art


def bog_lock(w: int, h: int, walk_y: int, seed: int = 3) -> Scene:
    """Bog water with a boardwalk band (two tiles tall) at walk_y."""
    s = Scene(w, h, ART, seed=seed)
    s.floor("bog", variants=12)
    s.floor("boardwalk", (0, walk_y, w, walk_y + 128), variants=4)
    return s


def deck(w: int, h: int, wall_rows: int = 1, kind: str = "plating", seed: int = 5) -> Scene:
    """A station room: a north wall band over deck plating."""
    s = Scene(w, h, ART, seed=seed)
    s.floor(kind, variants=16 if kind in ("plating", "floor") else 3)
    s.wall_band(0, wall_rows)
    return s


# ---------------------------------------------------------------------------
# A. Quickdraw


def strip_a() -> Strip:
    # 1. Establishing shot.
    s1 = bog_lock(576, 400, 176)
    s1.prop("spore-barrel", 520, 160)
    s1.char("drowned-diver", "ne", 430, 290)
    s1.char("vine-ranger", "e", 120, 300, state="walk", i=2)
    s1.gun(130, 248, ang=20)
    p1 = Panel(s1, 1, "TODAY",
               "Bog Lock 3. Visibility: soup. Company: one drowned diver, facing the wrong way.",
               labels=[Label("you", 0.21, 0.86, (0.21, 0.77), BIO)])

    # 2. He turns: the alert and the snap round.
    s2 = bog_lock(288, 200, 70)
    s2.ghosts(ART.char("drowned-diver", "ne"), [dict(x=150, y=180)])
    s2.char("drowned-diver", "w", 140, 182)
    p2 = Panel(s2, 2, "TODAY", Caption("He turns. The sim holds his first shot for a 16-tick draw.", "bl"),
               sfx=[Sfx("!", 0.5, 0.12, 56, 0, RED)])

    # 3. TODAY's clip, as a filmstrip.
    s3 = Scene(576, 400, ART, bg=INK)
    d = ImageDraw.Draw(s3.im)
    d.rectangle((0, 120, 576, 300), fill=rgba(PLUM))
    for k in range(0, 576, 18):
        d.rectangle((k + 4, 126, k + 12, 134), fill=rgba(MET_M))
        d.rectangle((k + 4, 286, k + 12, 294), fill=rgba(MET_M))
    for i in range(8):
        f = ART.char("drowned-diver", "e", "draw", i).crop((18, 0, 90, 96))
        s3.im.alpha_composite(f, (i * 72, 180))
        d.rectangle((i * 72, 140, i * 72 + 70, 280), outline=rgba(MET))
    d.rectangle((432, 138, 574, 282), outline=rgba(RED), width=3)
    p3 = Panel(s3, 1, "TODAY",
               Caption("Already shipping: an 8-frame draw, rotoscoped. Only the arm moves.", "top"),
               labels=[Label(str(i), (i * 72 + 36) / 576, 0.75, None, MET_XL, 24, None) for i in range(8)]
               + [Label("6-7 put it away again,\nthen the code pistol pops in", 0.6, 0.9, (0.87, 0.72), GOLD)])

    # 4. PROPOSED: the whole body draws (dip, whip, settle).
    s4 = bog_lock(576, 400, 200, seed=4)
    a, b, c = (ART.char("drowned-diver", "e", "draw", i) for i in (1, 3, 4))
    s4.char("drowned-diver", "e", 100, 334, "draw", 1, rot=-9, sy=0.9)  # dip: weight drops, shoulder loads
    s4.ghosts(a, [dict(x=262, y=332, rot=-6, sy=0.92)])
    s4.ghosts(b, [dict(x=274, y=330, rot=0), dict(x=280, y=330, rot=4)])
    s4.char("drowned-diver", "e", 286, 330, "draw", 3, rot=7)  # whip: overshoots the mark
    s4.char("drowned-diver", "e", 470, 330, "draw", 4, rot=2)  # settle: ends IN the aim
    s4.dashed([(318, 262), (340, 236), (356, 226), (372, 228)], GOLD)
    s4.speed_lines(355, 226, -30, n=3, length=18, spread=10)
    s4.dust(300, 332, 4, 10)
    p4 = Panel(s4, 1, "PROPOSED",
               Caption("Flashback-style: the whole body draws. Dip, half-step, whip past the mark, settle. Ends IN the aim pose.", "top"),
               labels=[Label("1 dip", 0.17, 0.92, None, PAPER), Label("2 whip", 0.5, 0.92, None, PAPER),
                       Label("3 settle", 0.82, 0.92, None, PAPER)],
               sfx=[Sfx("SHHK", 0.6, 0.42, 22, -12)])

    # 5. You strafe; eyes and gun stay on him.
    s5 = bog_lock(576, 400, 150, seed=6)
    ranger = ART.char("vine-ranger", "e", "walk", 4)
    s5.ghosts(ranger, [dict(x=150, y=190), dict(x=150, y=226)])
    s5.char("vine-ranger", "e", 150, 262, "walk", 4)
    s5.gun(162, 212, ang=-6)
    s5.char("drowned-diver", "w", 470, 214, "draw", 4)
    s5.dashed([(186, 208), (430, 172)], RED, 6, 6)
    s5.bolt(250, 199, 300, 192)
    s5.bolt(410, 168, 360, 176)
    p5 = Panel(s5, 1, "IN FLIGHT",
               Caption("She strafes down the boardwalk. Feet go one way, gun stays on him (aim + aimwalk).", "bl"),
               balloons=[Balloon("Blub.", 0.86, 0.14, (0.82, 0.3))],
               sfx=[Sfx("PEW", 0.47, 0.32, 18, -6, BIO_L)])

    # 6. Resolution.
    s6 = bog_lock(288, 200, 70, seed=8)
    s6.char("drowned-diver", "w", 160, 186, "draw", 6, rot=-10, color=PAPER, color_amt=0.6)
    s6.fx("hit-spark", 150, 140, 0.8)
    s6.bolt(20, 150, 128, 142)
    p6 = Panel(s6, 2, None, Caption("Total duel: 0.6 seconds. The comic about it: six panels.", "tl"),
               sfx=[Sfx("TSSK", 0.75, 0.4, 24, 10, BIO_L)])
    return Strip("A", "Quickdraw at Bog Lock 3",
                 "A drowner spots you and draws in one fluid motion; you strafe and keep him in your sights.",
                 [[p1, p2, p3], [p4, p5, p6]])


# ---------------------------------------------------------------------------
# Shared panel kinds


def card(w: int, h: int, title: str, lines: list[tuple[str, str]], size: int = 26) -> Scene:
    """A code/data card at k=1: a dark terminal with coloured lines."""
    sc = Scene(w, h, ART, bg=NIGHT)
    d = ImageDraw.Draw(sc.im)
    for y in range(0, h, 16):
        d.line((0, y, w, y), fill=rgba(PLUM))
    d.rectangle((16, 16, w - 16, h - 16), fill=rgba(INK), outline=rgba(TEAL_M), width=2)
    d.rectangle((16, 16, w - 16, 44), fill=rgba(TEAL_D))
    d.text((28, 20), title, font=font(FONT_TEXT, 24), fill=rgba(TEAL_XL))
    f = font(FONT_TEXT, size)
    y = 54
    for color, text in lines:
        d.text((30, y), text, font=f, fill=rgba(color))
        y += size - 2
    return sc


def phone(screen: Image.Image, label: str, label_color: str = BIO) -> Image.Image:
    """A landscape phone around a screen image."""
    pad, bez = 22, 14
    w, h = screen.width + 2 * pad, screen.height + 2 * bez
    im = Image.new("RGBA", (w, h + 34))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=26, fill=rgba(MET_D), outline=rgba(INK), width=4)
    d.rounded_rectangle((4, 4, w - 5, h - 5), radius=22, outline=rgba(MET_M), width=2)
    d.ellipse((8, h // 2 - 4, 16, h // 2 + 4), fill=rgba(INK))
    im.alpha_composite(screen, (pad, bez))
    d.rectangle((pad, bez, pad + screen.width - 1, bez + screen.height - 1), outline=rgba(INK), width=2)
    f = font(FONT_TITLE, 14)
    tw = f.getlength(label)
    d.rectangle((w / 2 - tw / 2 - 8, h + 6, w / 2 + tw / 2 + 8, h + 30), fill=rgba(label_color), outline=rgba(INK), width=2)
    d.text((w / 2 - tw / 2, h + 11), label, font=f, fill=rgba(INK))
    return im


def tumble(sc: Scene, kind: str, d: str, path: list[tuple[int, int, float]], ghost_alpha: bool = True,
           contacts: list[int] = ()) -> None:
    """A body thrown along `path` [(x, y_feet, rot)]: earlier poses as ghosts,
    the last one solid, dust at the contact points."""
    im = ART.char(kind, d)
    for k, (x, y, r) in enumerate(path[:-1]):
        sc.put(im, x, y, pivot="centre", rot=r, alpha=0.6 + 0.3 * k / len(path), color=TEAL_XL, color_amt=0.25,
               outline=PAPER)
    for k in contacts:
        x, y, _ = path[k]
        sc.dust(x, y + 30, 6, 18)
    x, y, r = path[-1]
    sc.put(im, x, y, pivot="centre", rot=r)


# ---------------------------------------------------------------------------
# B. Death knockback tumble


def strip_b() -> Strip:
    mut = "bog-mutant"
    s1 = deck(288, 200, seed=11)
    s1.char("vine-ranger", "e", 70, 184)
    s1.gun(80, 136, ang=0)
    s1.burst(108, 138, 6, 16, 9, GOLD)
    s1.char(mut, "w", 206, 186, color=PAPER, color_amt=0.4)
    s1.sparks(190, 138, 12, 16, GOLD, 0, 120)
    p1 = Panel(s1, 2, "TODAY", Caption("Point blank. The scatter-blaster's argument is short.", "bl"),
               sfx=[Sfx("BLAMM", 0.36, 0.25, 30, -10)])

    s2 = deck(288, 200, seed=12)
    s2.char("vine-ranger", "e", 50, 184, shadow=True)
    s2.gun(60, 136)
    s2.shadow(200, 186, 30, 6)
    s2.put(ART.char(mut, "w"), 214, 188, rot=-80, alpha=0.8)
    p2 = Panel(s2, 2, "TODAY",
               Caption("Today: he tips over on the spot and fades. Very polite. Very little shotgun.", "tl"),
               labels=[Label("dies exactly here", 0.72, 0.58, (0.66, 0.86), PAPER)])

    s3 = card(576, 400, "the death event, today vs proposed", [
        (MET_L, "today:"),
        (PAPER, " { type:'death', entityId, x, y }"),
        (MET_L, "  where, but not which way or how hard"),
        (ORANGE, "proposed (+2 numbers on the wire):"),
        (PAPER, " { type:'death', entityId, x, y,"),
        (GOLD, "   dir: angle of the blow, force: |knockback| }"),
        (MET_L, "render: the death GHOST already outlives"),
        (MET_L, "the entity. Give it a velocity, a spin,"),
        (MET_L, "gravity on a fake height z, floor bounces."),
        (BIO, "seed = hash(entityId, tick): every phone"),
        (BIO, "throws the same body the same way."),
    ], 25)
    p3 = Panel(s3, 1, "PROPOSED")

    s4 = deck(586, 200, seed=13)
    s4.char("vine-ranger", "e", 40, 186)
    s4.gun(50, 138)
    path = [(130, 140, 0), (218, 92, 115), (305, 140, 235), (392, 116, 330), (494, 160, 450)]
    s4.dashed([(x, y) for x, y, _ in path], GOLD, 5, 5)
    s4.shadow(500, 186, 34, 6)
    tumble(s4, mut, "w", path, contacts=[2])
    s4.speed_lines(150, 112, 0, 4, 22, 24)
    p4 = Panel(s4, 2, "PROPOSED",
               Caption("Proposed: the blow throws him. Hop, two bounces, a roll, a slide. All render-side.", "tl"),
               sfx=[Sfx("THUD", 0.52, 0.9, 22, -6, TAN_L), Sfx("thd", 0.86, 0.94, 16, 8, TAN_L)],
               labels=[Label("hop", 0.37, 0.3, None, GOLD), Label("bounce", 0.52, 0.5, None, GOLD),
                       Label("roll", 0.67, 0.36, None, GOLD), Label("slide", 0.84, 0.58, None, GOLD)], span=2)

    s5 = deck(288, 200, seed=14)
    s5.fx("ichor-splat", 150, 170, 0.55, alpha=0.7)
    s5.lines([(40, 176, 130, 178), (40, 182, 130, 184)], TAN_D, 2, 200)
    s5.put(ART.char(mut, "w"), 168, 178, rot=-90)
    s5.dust(60, 176, 5, 20, 3, MET_L, 140)
    p5 = Panel(s5, 2, "PROPOSED",
               Caption("Settles two tiles back. The sim forgot him the tick he died; the ghost does the falling.", "tl"))
    return Strip("B", "Hard hit, long goodbye",
                 "A heavy shot kills a bog mutant and throws him: he tumbles two or three times before settling.",
                 [[p1, p2, p3], [p4, p5]])


# ---------------------------------------------------------------------------
# C. Wall slam, ragdoll-lite


def strip_c() -> Strip:
    br = "carapace-brute"
    s1 = deck(288, 200, seed=21)
    s1.prop("spore-barrel", 196, 190)
    s1.char(br, "e", 130, 186)
    s1.bolt(0, 160, 60, 162)
    p1 = Panel(s1, 2, "TODAY", Caption("A carapace brute naps beside a spore barrel. Bold choice.", "bl"),
               sfx=[Sfx("zzz", 0.42, 0.42, 18, -8, TEAL_XL)])

    s2 = deck(288, 200, seed=22)
    s2.fx("spore-burst-2", 200, 170, 1.0)
    s2.burst(200, 172, 14, 34, 11, BIO_L, INK)
    s2.put(ART.char(br, "e"), 128, 128, pivot="centre", rot=-25)
    s2.speed_lines(128, 128, -100, 5, 30, 50)
    p2 = Panel(s2, 2, "PROPOSED", Caption("The barrel disagrees.", "bl"),
               sfx=[Sfx("FWOOMP", 0.64, 0.28, 28, 8, BIO_L)])

    s3 = deck(288, 200, seed=23)
    s3.burst(140, 62, 20, 46, 12, GOLD)
    d = ImageDraw.Draw(s3.im)
    for crack in ([(140, 60), (128, 44), (134, 30), (120, 18)], [(140, 60), (158, 46), (152, 30), (168, 12)],
                  [(140, 60), (110, 58), (96, 50)]):
        d.line(crack, fill=rgba(INK), width=2)
    s3.put(ART.char(br, "e"), 140, 80, pivot="centre", sx=1.25, sy=0.7, rot=180)
    s3.dust(140, 70, 10, 50, 3, MET_L)
    s3.sparks(140, 66, 10, 18, PAPER, 90, 160)
    p3 = Panel(s3, 2, "PROPOSED", Caption("SLAM: squash flat against the wall face for 3 frames.", "bl"),
               sfx=[Sfx("KRUNCH", 0.5, 0.12, 30, -4)])

    s4 = deck(288, 200, seed=24)
    d = ImageDraw.Draw(s4.im)
    for crack in ([(140, 60), (128, 44), (134, 30)], [(140, 60), (158, 46), (152, 30)]):
        d.line(crack, fill=rgba(INK), width=2)
    for x in (126, 134, 146):
        d.line((x, 40, x + 2, 92), fill=rgba(TEAL_D), width=3)
    s4.shadow(140, 104, 46, 8)
    s4.put(ART.char(br, "e"), 140, 100, pivot="centre", rot=160, sy=0.92)
    s4.dust(140, 106, 6, 40, 3, MET_L, 120)
    p4 = Panel(s4, 2, "PROPOSED",
               Caption("CRUMPLE, then SLUMP down the wall. Ragdoll-lite: three rigid poses on a spring. No bones were simulated.", "bl"))

    s5 = Scene(586, 200, ART, bg=INK)
    d = ImageDraw.Draw(s5.im)
    for x in range(0, 586, 32):
        d.line((x, 0, x, 200), fill=rgba(PLUM))
    for y in range(0, 200, 32):
        d.line((0, y, 586, y), fill=rgba(PLUM))
    d.rectangle((0, 0, 586, 31), fill=rgba(MET_D))
    for x in range(0, 586, 32):
        d.rectangle((x + 1, 1, x + 30, 30), outline=rgba(MET))
    s5.burst(150, 128, 8, 20, 9, BIO_L)
    ghost = ART.char(br, "e")
    for k, (x, y, r) in enumerate([(176, 112, -20), (214, 82, -60), (250, 54, -120)]):
        s5.put(ghost, x, y, pivot="centre", rot=r, sx=0.45, sy=0.45, alpha=0.35 + 0.15 * k, color=TEAL_XL, color_amt=0.5)
    s5.put(ghost, 300, 50, pivot="centre", rot=160, sx=0.45, sy=0.42)
    s5.dashed([(150, 128), (230, 72), (262, 40), (290, 46)], GOLD, 5, 4)
    d.line((262, 34, 262, 70), fill=rgba(BIO), width=2)
    d.polygon([(258, 66), (266, 66), (262, 74)], fill=rgba(BIO))
    d.ellipse((196, 166, 204, 174), fill=rgba(RED))
    d.ellipse((258, 30, 266, 38), fill=rgba(GOLD))
    s5.dashed([(262, 40), (264, 56), (266, 66)], CYAN, 3, 3)
    p5 = Panel(s5, 2, "PROPOSED", Caption(
        "Dead body: the ghost's display body checks the level tiles every phone already has; hit a wall, play SLAM, "
        "damp, SLUMP. Live body: the sim's own knockback already stops at the wall; the render just sees the stop.", "bottom"),
        labels=[Label("blast", 0.18, 0.5, (0.255, 0.64), BIO_L), Label("wall hit: SLAM", 0.64, 0.24, (0.45, 0.18), GOLD),
                Label("normal", 0.36, 0.3, (0.445, 0.3), BIO), Label("slump at the base", 0.7, 0.5, (0.51, 0.27), PAPER)],
        span=2)
    return Strip("C", "Wall slam",
                 "An explosion throws a brute into a wall: it slams, crumples and slides down. Ragdoll-lite.",
                 [[p1, p2, p3], [p4, p5]])


# ---------------------------------------------------------------------------
# D. Co-op over Bluetooth: display physics stays local


def fight_scene(throw: bool, seed: int) -> Scene:
    sc = deck(440, 230, seed=seed)
    sc.char("vine-ranger", "e", 70, 200)
    sc.gun(80, 152)
    sc.char("vine-ranger", "se", 130, 132, shadow=True)
    if throw:
        path = [(260, 150, 0), (305, 118, 100), (350, 140, 200), (395, 160, 280)]
        sc.dashed([(x, y) for x, y, _ in path], GOLD, 4, 4)
        tumble(sc, "bog-mutant", "w", path, contacts=[2])
    else:
        sc.char("bog-mutant", "w", 270, 200)
        sc.burst(108, 154, 5, 12, 8, GOLD)
    return sc


def strip_d() -> Strip:
    def pair(throw: bool) -> Image.Image:
        a = phone(fight_scene(throw, 31).im, "HOST")
        b = phone(fight_scene(throw, 31).im, "CLIENT", TEAL_XL)
        out = Image.new("RGBA", (1174 // 2 * 2, 400), rgba(PLUM))
        out.alpha_composite(a, (20, 60))
        out.alpha_composite(b, (out.width - b.width - 20, 60))
        d = ImageDraw.Draw(out)
        cx = out.width // 2
        for k in range(3):
            d.arc((cx - 30 - 12 * k, 170 - 30 - 12 * k, cx + 30 + 12 * k, 170 + 30 + 12 * k), -40, 40,
                  fill=rgba(CYAN), width=3)
            d.arc((cx - 30 - 12 * k, 170 - 30 - 12 * k, cx + 30 + 12 * k, 170 + 30 + 12 * k), 140, 220,
                  fill=rgba(CYAN), width=3)
        return out

    p1 = Panel(pair(False), 1, "TODAY",
               Caption("Two phones, no cell service. Same seed, same sim; the host streams snapshots over Bluetooth.", "top"),
               span=2)
    s2 = card(576, 400, "what crosses the air (reliable events)", [
        (PAPER, "host -> client:"),
        (GOLD, " death #41 @ (12.5, 7.0)"),
        (GOLD, "   dir 0.0 rad, force 28"),
        (MET_L, "   ~ a dozen bytes, once"),
        (PAPER, ""),
        (BIO, "client: same event, same seed"),
        (BIO, "   -> same tumble, computed locally"),
    ], 28)
    p2 = Panel(s2, 1, "PROPOSED", Caption("Only the event crosses: who, where, which way, how hard.", "bottom"))
    p3 = Panel(pair(True), 1, "PROPOSED",
               Caption("Each phone throws its own copy of the body, seeded by (entity, tick). Same flop on both screens, zero extra bytes.", "top"),
               labels=[Label("computed here", 0.25, 0.93, None, BIO), Label("and here", 0.75, 0.93, None, TEAL_XL)],
               span=2)
    s4 = card(576, 400, "never on the wire", [
        (MET_L, " ragdoll pose x 60 fps"),
        (MET_L, " corpse position updates"),
        (MET_L, " bounce / slam / slump state"),
        (PAPER, ""),
        (PAPER, " src/render only. The sim never"),
        (PAPER, " reads it back, so a frame of"),
        (PAPER, " difference on a slow phone is"),
        (PAPER, " cosmetic, never a desync."),
    ], 28)
    dd = ImageDraw.Draw(s4.im)
    for k in range(3):
        dd.line((34, 54 + 26 * k + 15, 300, 54 + 26 * k + 13), fill=rgba(RED), width=3)
    p4 = Panel(s4, 1, "PROPOSED", Caption("If the ragdoll rode the wire, the Bluetooth link would ragdoll too.", "bottom"),
               sfx=[Sfx("NOPE", 0.74, 0.25, 36, -12, RED, INK)])
    return Strip("D", "Two phones, one fight",
                 "Co-op over Bluetooth: both phones see the same kill and animate their own tumble. Sim positions stay identical.",
                 [[p1, p2], [p3, p4]])


# ---------------------------------------------------------------------------
# E. Spore-drone shot down


def strip_e() -> Strip:
    dr = ART.char("spore-drone", "s")

    def drone(sc: Scene, x: int, y: int, h: int, **kw) -> None:
        sc.shadow(x, y + h, max(8, 26 - h // 6), 5, 90)
        sc.put(dr, x, y, pivot="centre", **kw)

    s1 = deck(288, 200, seed=41)
    drone(s1, 180, 60, 110)
    s1.bolt(160, 90, 90, 140)
    s1.char("vine-ranger", "ne", 70, 192)
    p1 = Panel(s1, 2, "TODAY", Caption("A spore-drone holds the high ground. All forty centimetres of it.", "bl"))

    s2 = deck(288, 200, seed=42)
    drone(s2, 170, 76, 100, rot=28, color=PAPER, color_amt=0.3)
    s2.fx("hit-spark", 160, 70, 1.0)
    s2.sparks(176, 70, 12, 18, CYAN)
    s2.smoke(190, 50, 5, (20, -30), 6)
    p2 = Panel(s2, 2, "PROPOSED", Caption("A hard hit knocks its lift out.", "bl"), sfx=[Sfx("SPZZT", 0.72, 0.18, 24, 10, CYAN)])

    s3 = deck(586, 200, seed=43)
    ground = 176
    poses = [(110, 78, 35), (230, 58, 150), (350, 38, 275), (470, 16, 420)]
    s3.dashed([(x, ground - h - 4) for x, h, _ in poses], MET_XL, 4, 4)
    for k, (x, h, r) in enumerate(poses):
        s3.shadow(x, ground, 12 + 6 * k, 4, 60 + 30 * k)
        if k:
            px, ph, _ = poses[k - 1]
            s3.smoke((x + px) / 2, ground - (h + ph) / 2 - 20, 3, (-10, -12), 4)
        s3.put(dr, x, ground - h - 30, pivot="centre", rot=r, sx=0.8, sy=0.8, alpha=0.75 + 0.08 * k,
               outline=PAPER if k < 3 else None)
    p3 = Panel(s3, 2, "PROPOSED",
               Caption("It spirals: spin rate up, height down, smoke trail, shadow tightening under it. Display only.", "tl"),
               labels=[Label(t, x / 586, 0.96, None, PAPER, 22) for t, x in
                       [("high", 110), ("lower", 230), ("lower", 350), ("crash next", 470)]], span=2)

    s4 = deck(288, 200, seed=44)
    s4.shadow(150, 170, 40, 8)
    s4.put(dr, 140, 146, pivot="centre", rot=150, sy=0.9)
    s4.sparks(140, 160, 14, 20, GOLD, -90, 140)
    s4.smoke(160, 130, 6, (6, -60), 8)
    d = ImageDraw.Draw(s4.im)
    for k in range(7):
        x = 90 + s4.rng.randint(0, 130)
        y = 170 + s4.rng.randint(-8, 14)
        d.rectangle((x, y, x + 3, y + 2), fill=rgba(MET_L), outline=rgba(INK))
    p4 = Panel(s4, 2, "PROPOSED", Caption("Hover style finally gets to stop hovering.", "tl"),
               sfx=[Sfx("KRSSHH", 0.74, 0.62, 26, -6)])
    return Strip("E", "Spore-drone down",
                 "A drone shot out of the air spirals, smokes and crashes instead of fading where it hovered.",
                 [[p1, p2], [p3, p4]])


# ---------------------------------------------------------------------------
# F. Hound fidget interrupted


def strip_f() -> Strip:
    hd = "gloam-hound"
    s1 = Scene(288, 200, ART, seed=51)
    s1.floor("floor", variants=16)
    s1.char(hd, "s", 150, 180, rot=-8)
    s1.speed_lines(186, 96, 200, 3, 12, 10, TAN_L)
    s1.lines([(178, 106, 190, 112), (180, 114, 192, 118)], PAPER)
    p1 = Panel(s1, 2, "TODAY", Caption("Off duty. A fidget: the occasional idle scratch.", "tl"),
               sfx=[Sfx("scritch", 0.78, 0.4, 16, -10, TAN_L), Sfx("scritch", 0.8, 0.52, 14, 6, TAN_L)])

    s2 = Scene(288, 200, ART, seed=52)
    s2.floor("floor", variants=16)
    s2.floor("grate", (32, 128, 128, 200), variants=3)
    s2.char(hd, "s", 222, 132, rot=-8)
    s2.char("vine-ranger", "ne", 80, 196)
    p2 = Panel(s2, 2, "TODAY", Caption("You find the one loud grate in the station.", "tl"),
               sfx=[Sfx("CLANK", 0.24, 0.6, 18, -12, MET_XL)])

    s3 = Scene(288, 200, ART, seed=53)
    s3.floor("floor", variants=16)
    s3.ghosts(ART.char(hd, "s"), [dict(x=150, y=184, rot=-8)])
    s3.char(hd, "s", 150, 182, sx=0.9, sy=1.14)
    s3.speed_lines(150, 60, 90, 5, 16, 60)
    p3 = Panel(s3, 2, "PROPOSED",
               Caption("Proposed: an alert interrupt beats a fidget. Two snap frames: the scratch is cut, not finished.", "bl"),
               sfx=[Sfx("!", 0.5, 0.12, 50, 0, RED)])

    s4 = Scene(288, 200, ART, seed=54)
    s4.floor("floor", variants=16)
    s4.char(hd, "s", 150, 176, sx=1.12, sy=0.86)
    d = ImageDraw.Draw(s4.im)
    for k in range(7):
        x = 118 + k * 10
        d.line((x, 96 - (k % 2) * 3, x + 3, 84 - (k % 2) * 3), fill=rgba(BIO_L), width=1)
    p4 = Panel(s4, 2, "PROPOSED", Caption("Hackles up, low crouch, eyes on you. He was a good boy for four whole seconds.", "tl"),
               sfx=[Sfx("GRRR", 0.74, 0.86, 26, 4, RED)])
    return Strip("F", "Good boy, interrupted",
                 "Mid-scratch, a gloam hound hears you and snaps to alert.",
                 [[p1, p2], [p3, p4]])


# ---------------------------------------------------------------------------
# G. Room clear: holster, turn, skid


def strip_g() -> Strip:
    pr = "vine-ranger"
    s1 = deck(288, 200, seed=61)
    s1.put(ART.char("bog-mutant", "w"), 230, 150, rot=-90, alpha=0.5)
    s1.char(pr, "e", 80, 186)
    s1.gun(90, 138)
    p1 = Panel(s1, 2, "TODAY", Caption("Last one down. The room is quiet. The gun stays out anyway.", "tl"))

    s2 = deck(288, 200, seed=62)
    s2.char(pr, "e", 110, 186)
    s2.dashed([(130, 140), (134, 118), (120, 112), (108, 128), (106, 146)], GOLD, 3, 3)
    for x, y, a, alpha in [(116, 140, 0, 0.55), (126, 118, -100, 0.75), (106, 148, 95, 1.0)]:
        layer = Scene(288, 200, ART, bg=INK)
        layer.im.putalpha(0)
        layer.gun(x, y, ang=a)
        s2.put(layer.im, 0, 0, pivot=(0, 0), alpha=alpha, outline=PAPER if alpha < 1 else None)
    p2 = Panel(s2, 2, "PROPOSED",
               Caption("Holster when no hostile is in sight for 2 s. A spin, a click. The render decides; the sim never knows.", "tl"),
               sfx=[Sfx("click", 0.6, 0.78, 20, -8, PAPER)])

    s3 = deck(576, 400, seed=63)
    for k, (d, x) in enumerate([("e", 90), ("se", 190), ("s", 290), ("sw", 390), ("w", 490)]):
        s3.char(pr, d, x, 330, alpha=1 if k in (0, 4) else 0.85)
    s3.dust(290, 334, 5, 12)
    dd = ImageDraw.Draw(s3.im)
    dd.arc((90, 140, 490, 260), 200, 340, fill=rgba(GOLD), width=3)
    dd.polygon([(478, 176), (494, 184), (480, 194)], fill=rgba(GOLD))
    p3 = Panel(s3, 1, "PROPOSED",
               Caption("Today she flips 180 degrees in one frame. Proposed: pass through the in-between facings, pivot foot planted.", "top"),
               labels=[Label("~100 ms", 0.5, 0.36, None, GOLD)])

    s4 = deck(288, 200, seed=64)
    s4.ghosts(ART.char(pr, "e", "walk", 2), [dict(x=90, y=184), dict(x=130, y=184)])
    s4.char(pr, "e", 170, 186, "walk", 6, rot=-12)
    s4.lines([(70, 188, 160, 188), (74, 192, 164, 192)], TAN_D, 2, 180)
    s4.dust(196, 184, 8, 16, 4)
    p4 = Panel(s4, 2, "PROPOSED",
               Caption("Stop with a skid: lean back, dust forward. Her sim position stopped dead; the display only leans.", "tl"),
               sfx=[Sfx("SKRRT", 0.78, 0.6, 22, -6, TAN_L)])

    s5 = deck(288, 200, seed=65)
    s5.char(pr, "s", 144, 186, sy=1.02)
    s5.lines([(158, 82, 166, 76), (162, 88, 172, 86)], PAPER)
    p5 = Panel(s5, 2, "TODAY", Caption("Then she breathes. Tour guide mode.", "tl"))
    return Strip("G", "Room clear",
                 "Flashback's small in-between moves: holster when it's quiet, turn through the facings, skid to a stop.",
                 [[p1, p2, p3], [p4, p5]])


# ---------------------------------------------------------------------------
# H. The rotoscope route to a fluid draw


def strip_h() -> Strip:
    ref = Path("/mnt/d/tmp/cast-walks/mocap/ref/clip-s3")
    frames = sorted(ref.glob("*.png"))

    s1 = Image.new("RGBA", (576, 400), rgba(PLUM))
    if frames:
        shots = [Image.open(frames[i]).convert("RGBA") for i in (0, 20, 34, 50)]
        for k, im in enumerate(shots):
            im = im.crop((im.width // 2 - 120, 0, im.width // 2 + 120, im.height)).resize((120, 240))
            s1.alpha_composite(im, (24 + k * 136, 120))
    p1 = Panel(s1, 1, "TODAY",
               Caption("Flashback (1992) filmed real actors and traced them. Our pipeline already rotos from reference clips like this.", "top"))

    rig = Path("/mnt/d/tmp/cast-walks/mocap/rig/hand-strip.png")
    s2 = Image.new("RGBA", (576, 400), rgba(INK))
    if rig.exists():
        r = Image.open(rig).convert("RGBA")
        s2.alpha_composite(r.crop((0, 0, 1600, 240)).resize((576, 86)), (0, 170))
    p2 = Panel(s2, 1, "TODAY",
               Caption("But the draw's control skeleton moves one arm, and the prompt says 'the feet stay planted'.", "top"),
               labels=[Label("only the arm changes, frame to frame", 0.5, 0.86, None, GOLD)])

    s3 = Image.new("RGBA", (576, 400), rgba(PLUM))
    d = ImageDraw.Draw(s3)
    d.rounded_rectangle((60, 110, 230, 360), radius=18, fill=rgba(MET_D), outline=rgba(INK), width=4)
    d.rectangle((72, 130, 218, 330), fill=rgba(PAPER))
    d.ellipse((134, 148, 156, 170), outline=rgba(INK), width=3)
    d.line((145, 170, 140, 250), fill=rgba(INK), width=3)
    d.line((140, 250, 120, 318), fill=rgba(INK), width=3)
    d.line((140, 250, 168, 314), fill=rgba(INK), width=3)
    d.line((143, 190, 200, 178), fill=rgba(INK), width=3)
    d.line((143, 192, 118, 222), fill=rgba(INK), width=3)
    d.text((300, 150), "3 s of a real person:", font=font(FONT_TEXT, 30), fill=rgba(PAPER))
    for k, t in enumerate(["weight shift", "hip turn", "half step", "off-hand sweep", "overshoot + settle"]):
        d.text((310, 190 + k * 30), "- " + t, font=font(FONT_TEXT, 28), fill=rgba(GOLD))
    p3 = Panel(s3, 1, "PROPOSED",
               Caption("Proposed: film the draw on a phone and extract the skeleton from it. Real bodies don't stand still.", "top"))

    s4 = bog_lock(192, 134, 20, seed=71)
    s4.ghosts(ART.char("drowned-diver", "e", "draw", 1), [dict(x=70, y=124, rot=-9, sy=0.9)])
    s4.char("drowned-diver", "e", 112, 126, "draw", 4, rot=5)
    s4.speed_lines(150, 60, -20, 3, 12, 8)
    p4 = Panel(s4, 3, "PROPOSED",
               Caption("Same pipeline and palette; a performance, not a pose. It ends in aim and hands off to aimwalk.", "tl"))
    return Strip("H", "The rotoscope route",
                 "How a Flashback-fluid draw gets made: a filmed performance drives the existing roto pipeline.",
                 [[p1, p2], [p3, p4]])


STRIPS = {"A": strip_a, "B": strip_b, "C": strip_c, "D": strip_d, "E": strip_e, "F": strip_f, "G": strip_g,
          "H": strip_h}


def main() -> None:
    global ART
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="/mnt/d/tmp/cast-walks/comics")
    ap.add_argument("--ref", default="origin/ship/actions-1106")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ART = Art.from_ref(REPO, a.ref, out / "art-cache")
    for key, fn in STRIPS.items():
        if a.only and key not in a.only.split(","):
            continue
        im = fn().render()
        path = out / f"strip-{key}.png"
        im.convert("RGB").save(path)
        print(path, im.size)


if __name__ == "__main__":
    main()
