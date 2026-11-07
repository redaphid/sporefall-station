"""Design SKETCHES of the lore weapons, for the comics and as ControlNet structure
inputs only. Never shipped: the shipped art is generated from these."""
from PIL import Image, ImageDraw
OUT = (8, 8, 12)
S1, S2, S3, HI = (60, 68, 77), (89, 99, 109), (123, 135, 145), (162, 173, 180)
RUB, CAN, CAN2 = (35, 40, 46), (107, 77, 38), (143, 108, 56)
GLOW = {"teal": (60, 224, 216), "frost": (126, 203, 210), "orange": (255, 144, 50),
        "yellow": (255, 216, 62), "violet": (160, 90, 224), "green": (70, 224, 120)}

def jar(d, box, glow, bubbles=((0.35, 0.65), (0.6, 0.4), (0.45, 0.25)), phase=0):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=(x1 - x0) // 4, fill=tuple(int(c * 0.55) for c in glow), outline=OUT, width=3)
    d.rectangle((x0 + 4, y0 + 4, x0 + 8, y1 - 6), fill=tuple(min(255, int(c * 1.0 + 60)) for c in glow))
    w, h = x1 - x0, y1 - y0
    for i, (bx, by) in enumerate(bubbles):
        by = (by - 0.18 * phase) % 0.9 + 0.05
        r = max(3, w // 9) - i
        cx, cy = x0 + bx * w, y0 + by * h
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=glow, outline=(242, 246, 234), width=1)
    d.rectangle((x0 + w * 0.2, y0 - 6, x1 - w * 0.2, y0 + 2), fill=S2, outline=OUT, width=2)  # cap

def grip(d, x, y, l=46, ang=18):
    import math
    a = math.radians(90 - ang)
    dx, dy = math.cos(a) * l, math.sin(a) * l
    d.polygon([(x, y), (x + 22, y), (x + 22 - dx * 0.35, y + dy), (x - dx * 0.35 - 2, y + dy)], fill=RUB, outline=OUT)
    for k in range(1, 4):
        yy = y + dy * k / 4
        d.line((x - dx * 0.35 * k / 4, yy, x + 22 - dx * 0.35 * k / 4, yy), fill=CAN, width=3)

def hose(d, pts, w=7):
    d.line(pts, fill=OUT, width=w + 4, joint="curve"); d.line(pts, fill=RUB, width=w, joint="curve")

def jar_pistol(d, ox, oy, glow=GLOW["teal"], phase=0):
    d.rectangle((ox + 30, oy + 40, ox + 130, oy + 66), fill=S2, outline=OUT, width=3)           # still body
    d.rectangle((ox + 130, oy + 46, ox + 190, oy + 60), fill=S1, outline=OUT, width=3)          # short barrel
    d.ellipse((ox + 182, oy + 42, ox + 198, oy + 64), fill=S1, outline=OUT, width=3)            # bore lip
    d.line((ox + 34, oy + 44, ox + 126, oy + 44), fill=S3, width=3)
    jar(d, (ox + 60, oy + 2, ox + 100, oy + 42), glow, phase=phase)                              # essence jar on top
    d.rectangle((ox + 104, oy + 30, ox + 118, oy + 40), fill=S3, outline=OUT, width=2)          # petcock
    d.line((ox + 111, oy + 22, ox + 111, oy + 30), fill=OUT, width=4)
    hose(d, [(ox + 60, oy + 30), (ox + 38, oy + 24), (ox + 34, oy + 42)], 5)
    grip(d, ox + 40, oy + 66)

def scatter_funnel(d, ox, oy, glow=GLOW["teal"], phase=0):
    d.rectangle((ox + 70, oy + 40, ox + 200, oy + 68), fill=S2, outline=OUT, width=3)
    d.polygon([(ox + 200, oy + 46), (ox + 250, oy + 26), (ox + 250, oy + 86), (ox + 200, oy + 64)], fill=S3, outline=OUT)
    d.line((ox + 204, oy + 50, ox + 246, oy + 34), fill=HI, width=2)
    d.polygon([(ox + 0, oy + 50), (ox + 70, oy + 44), (ox + 70, oy + 66), (ox + 6, oy + 80)], fill=CAN, outline=OUT)  # wrapped stock
    for k in range(4): d.line((ox + 12 + k * 15, oy + 48, ox + 16 + k * 15, oy + 76), fill=CAN2, width=2)
    d.rounded_rectangle((ox + 100, oy + 66, ox + 196, oy + 84), radius=8, fill=S1, outline=OUT, width=3)  # pressure tank
    d.rounded_rectangle((ox + 120, oy + 48, ox + 140, oy + 62), radius=4, fill=tuple(int(c * .6) for c in glow), outline=OUT, width=2)
    d.rectangle((ox + 124, oy + 51, ox + 127, oy + 59), fill=glow)
    grip(d, ox + 74, oy + 66, 44)

def coil_repeater(d, ox, oy, glow=GLOW["teal"], phase=0):
    d.rectangle((ox + 40, oy + 46, ox + 120, oy + 70), fill=S2, outline=OUT, width=3)
    d.rectangle((ox + 120, oy + 50, ox + 240, oy + 64), fill=S1, outline=OUT, width=3)
    for k in range(10): d.ellipse((ox + 126 + k * 11, oy + 44, ox + 136 + k * 11, oy + 70), outline=CAN2, width=3)  # coil wrap
    d.polygon([(ox + 80, oy + 70), (ox + 104, oy + 70), (ox + 110, oy + 112), (ox + 88, oy + 114)], fill=S1, outline=OUT)  # box magazine
    d.polygon([(ox + 0, oy + 52), (ox + 40, oy + 48), (ox + 40, oy + 70), (ox + 4, oy + 84)], fill=CAN, outline=OUT)  # stock
    for k in range(3): d.ellipse((ox + 150 + k * 11, oy + 44, ox + 160 + k * 11, oy + 70), outline=glow, width=3)  # the hot coil turns
    grip(d, ox + 52, oy + 70, 40)

def phosphor_hose(d, ox, oy, glow=GLOW["orange"], phase=0):
    d.rectangle((ox + 60, oy + 48, ox + 210, oy + 62), fill=S1, outline=OUT, width=3)       # wand
    d.polygon([(ox + 210, oy + 46), (ox + 236, oy + 50), (ox + 236, oy + 60), (ox + 210, oy + 64)], fill=S3, outline=OUT)
    d.ellipse((ox + 228, oy + 50, ox + 240, oy + 60), fill=glow, outline=OUT)               # pilot glow
    hose(d, [(ox + 62, oy + 56), (ox + 20, oy + 70), (ox + 30, oy + 110), (ox + 90, oy + 120)], 10)
    jar(d, (ox + 120, oy + 10, ox + 150, oy + 46), glow, phase=phase)
    grip(d, ox + 80, oy + 62, 38)

def decanter(d, ox, oy, glow=GLOW["teal"], phase=0):
    # the sidearm: a caged glass bulb IS the barrel; a petcock decants one bubble out of its neck
    d.rectangle((ox + 30, oy + 44, ox + 84, oy + 68), fill=S2, outline=OUT, width=3)            # valve block
    d.line((ox + 34, oy + 48, ox + 80, oy + 48), fill=S3, width=3)
    jar(d, (ox + 84, oy + 22, ox + 160, oy + 90), glow, bubbles=((.35, .6), (.6, .45), (.45, .3)), phase=phase)
    for k in range(4): d.line((ox + 96 + k * 18, oy + 20, ox + 96 + k * 18, oy + 92), fill=OUT, width=3)   # wire cage
    d.arc((ox + 80, oy + 18, ox + 164, oy + 94), 0, 360, fill=OUT, width=3)
    d.rectangle((ox + 160, oy + 48, ox + 196, oy + 64), fill=S1, outline=OUT, width=3)          # neck nozzle
    d.ellipse((ox + 190, oy + 46, ox + 202, oy + 66), fill=S1, outline=OUT, width=3)
    d.rectangle((ox + 48, oy + 30, ox + 62, oy + 44), fill=S3, outline=OUT, width=2)            # petcock
    d.line((ox + 40, oy + 32, ox + 70, oy + 32), fill=OUT, width=4)
    hose(d, [(ox + 32, oy + 56), (ox + 10, oy + 64), (ox + 8, oy + 110)], 5)
    grip(d, ox + 40, oy + 68)

def rivet_driver(d, ox, oy, glow=GLOW["green"], phase=0):
    # the sidearm: a salvaged pneumatic rivet driver. Heavy steel body, a thick
    # reinforced barrel, a pressure cylinder under it, ONE small charge vial.
    d.rounded_rectangle((ox + 24, oy + 30, ox + 120, oy + 70), radius=6, fill=S2, outline=OUT, width=3)   # receiver
    d.line((ox + 28, oy + 35, ox + 116, oy + 35), fill=S3, width=4)
    d.rectangle((ox + 120, oy + 34, ox + 200, oy + 56), fill=S1, outline=OUT, width=3)                    # thick barrel
    d.line((ox + 122, oy + 38, ox + 196, oy + 38), fill=S3, width=3)
    d.rectangle((ox + 190, oy + 28, ox + 212, oy + 62), fill=S2, outline=OUT, width=3)                    # muzzle collar
    d.rectangle((ox + 207, oy + 38, ox + 214, oy + 52), fill=OUT)                                         # bore
    for k in range(3): d.rectangle((ox + 136 + k * 18, oy + 32, ox + 142 + k * 18, oy + 58), fill=S2, outline=OUT, width=2)  # clamp bands
    d.rounded_rectangle((ox + 110, oy + 58, ox + 186, oy + 76), radius=8, fill=S1, outline=OUT, width=3)   # pressure cylinder
    d.rounded_rectangle((ox + 70, oy + 40, ox + 96, oy + 56), radius=5, fill=tuple(int(c * .6) for c in glow), outline=OUT, width=3)  # charge vial
    d.rectangle((ox + 74, oy + 43, ox + 78, oy + 53), fill=glow)
    d.rectangle((ox + 30, oy + 20, ox + 60, oy + 30), fill=S1, outline=OUT, width=3)                      # hammer block
    grip(d, ox + 34, oy + 70, 54)

def frost_condenser(d, ox, oy, glow=GLOW["frost"], phase=0):
    jar_pistol(d, ox, oy, glow, phase)
    for k in range(5): d.rectangle((ox + 136 + k * 10, oy + 38, ox + 141 + k * 10, oy + 68), fill=HI, outline=OUT, width=2)  # fins

def lull_darter(d, ox, oy, glow=GLOW["violet"], phase=0):
    d.rectangle((ox + 30, oy + 48, ox + 210, oy + 60), fill=S2, outline=OUT, width=3)
    d.polygon([(ox + 210, oy + 50), (ox + 232, oy + 54), (ox + 210, oy + 58)], fill=HI, outline=OUT)
    jar(d, (ox + 70, oy + 14, ox + 98, oy + 48), glow, phase=phase)
    grip(d, ox + 44, oy + 60, 42)

def spark_coil(d, ox, oy, glow=GLOW["yellow"], phase=0):
    d.rectangle((ox + 30, oy + 40, ox + 120, oy + 66), fill=S2, outline=OUT, width=3)
    d.line((ox + 120, oy + 44, ox + 180, oy + 36), fill=OUT, width=9); d.line((ox + 120, oy + 44, ox + 180, oy + 36), fill=S3, width=5)
    d.line((ox + 120, oy + 62, ox + 180, oy + 70), fill=OUT, width=9); d.line((ox + 120, oy + 62, ox + 180, oy + 70), fill=S3, width=5)
    for k in range(5): d.ellipse((ox + 124 + k * 10, oy + 46, ox + 132 + k * 10, oy + 60), outline=CAN2, width=3)
    jar(d, (ox + 56, oy + 0, ox + 96, oy + 40), glow, phase=phase)
    grip(d, ox + 40, oy + 66)

def pressure_lance(d, ox, oy, glow=GLOW["teal"], phase=0):
    d.rectangle((ox + 0, oy + 50, ox + 230, oy + 62), fill=S1, outline=OUT, width=3)        # still pipe shaft
    d.rounded_rectangle((ox + 196, oy + 34, ox + 230, oy + 78), radius=4, fill=S1, outline=OUT, width=3)  # piston cylinder
    d.rectangle((ox + 230, oy + 30, ox + 262, oy + 82), fill=S2, outline=OUT, width=3)                     # heavy piston head
    d.line((ox + 234, oy + 34, ox + 234, oy + 78), fill=S3, width=3)
    d.rounded_rectangle((ox + 100, oy + 40, ox + 122, oy + 52), radius=4, fill=tuple(int(c * .6) for c in glow), outline=OUT, width=2)
    d.rectangle((ox + 104, oy + 43, ox + 108, oy + 49), fill=glow)
    d.rectangle((ox + 134, oy + 40, ox + 148, oy + 50), fill=S3, outline=OUT, width=2)
    d.rectangle((ox + 10, oy + 48, ox + 60, oy + 64), fill=CAN, outline=OUT, width=2)      # canvas grip wrap
    for k in range(5): d.line((ox + 14 + k * 10, oy + 48, ox + 18 + k * 10, oy + 64), fill=CAN2, width=2)

def siphon_spike(d, ox, oy, glow=GLOW["teal"], phase=0):
    d.rectangle((ox + 10, oy + 46, ox + 60, oy + 64), fill=RUB, outline=OUT, width=3)
    for k in range(4): d.line((ox + 14 + k * 12, oy + 46, ox + 16 + k * 12, oy + 64), fill=CAN, width=3)
    d.rectangle((ox + 60, oy + 42, ox + 70, oy + 68), fill=S2, outline=OUT, width=2)
    jar(d, (ox + 70, oy + 44, ox + 130, oy + 66), glow, bubbles=((.3, .5), (.6, .5), (.85, .5)), phase=phase)  # glass barrel
    d.polygon([(ox + 130, oy + 50), (ox + 180, oy + 55), (ox + 130, oy + 60)], fill=HI, outline=OUT)  # needle

def condenser_ram(d, ox, oy, glow=GLOW["yellow"], phase=0):
    d.rectangle((ox + 0, oy + 54, ox + 190, oy + 64), fill=S1, outline=OUT, width=3)
    d.rectangle((ox + 10, oy + 52, ox + 70, oy + 66), fill=CAN, outline=OUT, width=2)
    d.polygon([(ox + 186, oy + 40), (ox + 196, oy + 20), (ox + 250, oy + 14), (ox + 250, oy + 104), (ox + 196, oy + 98), (ox + 186, oy + 78)], fill=S2, outline=OUT)
    jar(d, (ox + 204, oy + 30, ox + 242, oy + 88), glow, phase=phase)
    d.line((ox + 196, oy + 20, ox + 196, oy + 98), fill=OUT, width=3)
    for k in range(4): d.line((ox + 200 + k * 14, oy + 16, ox + 200 + k * 14, oy + 102), fill=OUT, width=3)  # wire cage

WEAPONS = {
    "rivetDriver": ("Rivet Driver", rivet_driver, "green"),
    "scatterFunnel": ("Scatter Funnel", scatter_funnel, "teal"),
    "coilRepeater": ("Coil Repeater", coil_repeater, "teal"),
    "phosphorHose": ("Phosphor Hose", phosphor_hose, "orange"),
    "frostCondenser": ("Frost Condenser", frost_condenser, "frost"),
    "lullDarter": ("Lull Darter", lull_darter, "violet"),
    "sparkCoil": ("Spark Coil", spark_coil, "yellow"),
    "pressureLance": ("Pressure Lance", pressure_lance, "teal"),
    "siphonSpike": ("Siphon Spike", siphon_spike, "teal"),
    "cageRam": ("Cage Ram", condenser_ram, "yellow"),
}

def sketch(wid, w=280, h=130, bg=(0, 0, 0, 0), phase=0):
    im = Image.new("RGBA", (w, h), bg)
    d = ImageDraw.Draw(im)
    _, fn, g = WEAPONS[wid]
    fn(d, 10, 8, GLOW[g], phase)
    return im
