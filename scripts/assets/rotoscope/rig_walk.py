#!/usr/bin/env python3
"""Blender headless motion source for rotoscoped walk cycles (Flashback-style).

Builds a fully PROCEDURAL color-blocked humanoid proxy (no external rig or
mesh assets — everything is bpy primitives created by this script, so the
motion source is license-clean by construction) and renders an 8-frame
hand-parameterized walk cycle from the game's 5 drawn view directions
(s se e ne n — west is mirrored by the engine, never drawn).

The proxy is color-blocked as the character (default: the vine-ranger — teal
suit, orange cap, dark visor, brown boots/strap) because the AI tracer keeps
composition at low denoise: giving it the right color regions to "develop"
into pack style is what keeps every frame the same character.

The walk cycle is the classic 4-keypose stride (contact / down / passing / up,
Richard Williams) written out explicitly for 8 frames. Hip height is solved
per frame by leg FK so the stance foot always touches the ground — bob comes
out of the geometry instead of floating/hovering feet.

Runs INSIDE Blender:
  blender.exe -b -P rig_walk.py -- --out D:/tmp/backseat-roto/frames [--res 1024]

Output: <out>/walk-<dir>-<n>.png  (5 dirs x 8 frames, RGBA, transparent bg,
fixed orthographic camera at the game's slight-high angle; identical framing
across every frame and direction so downstream scaling is uniform).
"""
import math
import sys

import bpy
from mathutils import Matrix, Vector

# ---- CLI --------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = arg("--out", "D:/tmp/backseat-roto/frames").rstrip("/")
RES = int(arg("--res", "1024"))

# Screen-facing convention: camera looks along +Y, screen-right = world +X.
# Character faces -Y at yaw 0 (toward camera = "s"). e/ne face RIGHT (mirrored
# at runtime for the west half) per the pack's facing convention.
DIRS = {"s": 0.0, "se": 45.0, "e": 90.0, "ne": 135.0, "n": 180.0}
FRAMES = 8

# ---- palette-ish color blocking (sRGB hex -> linear) ------------------------


def lin(hexstr):
    h = hexstr.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4)) + (1.0,)


COL_SUIT = lin("#3a7a80")      # teal spacesuit
COL_SUIT_DARK = lin("#24565c")  # lower legs / shading blocks
COL_CAP = lin("#ff7a14")       # orange-amber cap (hot: must survive
                               # shading + palette-snap as #ff9032, not tan)
COL_VISOR = lin("#1c1420")     # dark visor face
COL_BOOT = lin("#6b4d26")      # tan-brown boots
COL_STRAP = lin("#4a3419")     # leather chest strap
COL_PACK = lin("#59636d")      # back pack: locked-palette GREY, not teal. The
                               # back quarter is 16 of the 40 frames and the
                               # pack owns most of those pixels — the curated
                               # n-idle spends 96 px on #59636d and 57 on
                               # #3c444d, so a dark-teal pack (the r1 color)
                               # reads as a different character from behind
                               # even when the silhouette is exact. Shading
                               # spreads this base across the palette's grey
                               # ramp the same way the curated art does.
COL_GLOVE = lin("#23282e")     # gloves
COL_VINE = lin("#4c6b28")      # vine wrap on one arm
COL_ARMOR = lin("#7b8791")     # grey plate: pauldrons, chest rig, collar,
                               # knee. Sits a ramp step above COL_PACK so lit
                               # plating resolves to #7b8791/#a2adb4 and shaded
                               # plating to #59636d — the curated ranger's grey
                               # gear read, which a teal-leaning grey loses to
                               # the suit color at palette-snap.
COL_POUCH = lin("#5a4526")     # belt pouches / utility rig

# ---- proportions: the CURATED vine-ranger's build, not a generic humanoid ---
# The proxy silhouette IS the consistency contract (docs/sprite-generation.md
# "Family consistency"): the tracer keeps composition at low denoise, so if the
# proxy is a lithe figure the shipped walk cycle is a lithe figure — a
# different character from the geared idles. These numbers are derived from
# the curated s-idle's row profile (scripts/assets/consistency.py), read as
# FRACTIONS OF STANDING HEIGHT so the rig reproduces the same build:
#
#   0.00-0.19  helmet block   span 10/20 of the shoulder peak (visored dome
#              sitting straight on the collar — the ranger has NO bare neck;
#              a neck notch is what collapsed head_h to 3px in the r1 cycle)
#   0.20-0.39  shoulders/chest/arms, PEAK span 20 (pauldrons + pack)
#   0.41-0.45  waist          span 13
#   0.48-0.55  hip/belt rig   span 15 (pouches flare back out)
#   0.57-1.00  legs           span 8-10, i.e. 0.40 of peak — comfortably under
#              the head-block cut, which is what makes head_h break cleanly at
#              the crotch instead of running down the legs
#
# Width/height at the peak is 20/44 = 0.455; the r1 proxy was 0.28 (that is
# the entire "slimmer character" defect). Legs are 0.39 of height here, NOT
# the 0.56 a default humanoid gets — short-legged and long-torsoed is the
# ranger's read.
HIP_H = 0.77        # nominal hip height (auto-grounded per frame)
THIGH, SHIN = 0.31, 0.31
HIP_W = 0.11        # hip joint x offset
SHOULDER_W = 0.30   # shoulder joint x offset (pauldron adds another 0.13)
UARM, FARM = 0.30, 0.27
SPINE_OFF = 0.05    # hips empty -> spine origin
SHOULDER_H = 0.50   # spine origin -> shoulder joints
NECK_H = 0.62       # spine origin -> head origin
# limb radii: geared, not lithe (r1 used 0.062/0.052/0.05)
R_THIGH, R_SHIN, R_UARM, R_FARM = 0.085, 0.075, 0.075, 0.066


def mat(name, color, glow=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.85
    if glow:  # signature colors must stay saturated through shading
        bsdf.inputs["Emission Color"].default_value = color
        bsdf.inputs["Emission Strength"].default_value = glow
    return m


MATS = {}
GLOW = {"cap": 0.55, "visor": 0.15}


def M(name, color):
    if name not in MATS:
        MATS[name] = mat(name, color, glow=GLOW.get(name, 0.0))
    return MATS[name]


def segment(name, parent, offset, length, radius, color, joint_ball=True):
    """Limb segment: cylinder hanging -Z from its origin (the joint)."""
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=length, vertices=16)
    ob = bpy.context.object
    ob.name = name
    ob.data.transform(Matrix.Translation((0, 0, -length / 2)))
    ob.data.materials.append(M(color[0], color[1]))
    ob.parent = parent
    ob.location = offset
    if joint_ball:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius * 1.05, segments=12, ring_count=8)
        ball = bpy.context.object
        ball.name = name + ".joint"
        ball.data.materials.append(M(color[0], color[1]))
        ball.parent = ob
        ball.location = (0, 0, 0)
    return ob


def box(name, parent, offset, dims, color, shift=(0, 0, 0)):
    """Axis-aligned box; origin at `offset` in parent space, geometry shifted."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    ob = bpy.context.object
    ob.name = name
    sx, sy, sz = dims
    ob.data.transform(Matrix.Diagonal((sx, sy, sz, 1)))
    ob.data.transform(Matrix.Translation(shift))
    ob.data.materials.append(M(color[0], color[1]))
    ob.parent = parent
    ob.location = offset
    return ob


def ball(name, parent, offset, radius, color, squash=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=16, ring_count=12)
    ob = bpy.context.object
    ob.name = name
    ob.data.transform(Matrix.Diagonal(tuple(squash) + (1,)))
    ob.data.materials.append(M(color[0], color[1]))
    ob.parent = parent
    ob.location = offset
    return ob


# ---- build scene ------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

root = bpy.data.objects.new("root", None)
bpy.context.collection.objects.link(root)

hips = bpy.data.objects.new("hips", None)
bpy.context.collection.objects.link(hips)
hips.parent = root
hips.location = (0, 0, HIP_H)

# hip/belt rig: the curated ranger flares back OUT at the belt (span 15 after
# a 13 waist) — pelvis plus utility pouches, so the head-block occupancy run
# survives the waist and only breaks at the crotch.
pelvis = box("pelvis", hips, (0, 0, 0.02), (0.42, 0.22, 0.18), ("suit", COL_SUIT))
for side, sx in (("L", -1), ("R", 1)):
    box(f"pouch.{side}", hips, (sx * 0.25, -0.02, 0.0), (0.16, 0.15, 0.15),
        ("pouch", COL_POUCH))

thighs, shins, boots = {}, {}, {}
for side, sx in (("L", -1), ("R", 1)):
    th = segment(f"thigh.{side}", hips, (sx * HIP_W, 0, -0.03), THIGH, R_THIGH,
                 ("suit", COL_SUIT))
    sh = segment(f"shin.{side}", th, (0, 0, -THIGH), SHIN, R_SHIN,
                 ("suitdark", COL_SUIT_DARK))
    # knee plate: gear read on the leg without widening the leg block past
    # the head-block cut (legs must stay ~0.45 of the shoulder peak)
    box(f"knee.{side}", sh, (0, -0.03, -0.02), (0.17, 0.13, 0.11),
        ("armor", COL_ARMOR))
    bt = box(f"boot.{side}", sh, (0, 0, -SHIN), (0.17, 0.28, 0.16),
             ("boot", COL_BOOT), shift=(0, -0.06, 0.02))  # toe toward -Y (front)
    thighs[side], shins[side], boots[side] = th, sh, bt

spine = bpy.data.objects.new("spine", None)
bpy.context.collection.objects.link(spine)
spine.parent = hips
spine.location = (0, 0, SPINE_OFF)

# long, deep torso (0.20-0.55 of height) — the ranger is long-torsoed
box("torso", spine, (0, 0, 0.30), (0.52, 0.24, 0.60), ("suit", COL_SUIT))
# chest rig plate: the geared read on the front quarter
box("chestrig", spine, (0, -0.135, 0.32), (0.40, 0.06, 0.22), ("armor", COL_ARMOR))
# leather chest strap: thin diagonal slab across the front
strap = box("strap", spine, (0, -0.128, 0.22), (0.44, 0.02, 0.07), ("strap", COL_STRAP))
strap.rotation_euler = (0, math.radians(28), 0)
# backpack: real bulk, and the thing that reads as gear from n/ne
box("pack", spine, (0, 0.19, 0.34), (0.36, 0.20, 0.36), ("pack", COL_PACK))

# collar: bridges shoulders to helmet. The ranger has NO bare neck — this
# block is what keeps the head-block occupancy run unbroken from the helmet
# down through the torso (r1's neck notch is why head_h read 3px, not 27).
box("collar", spine, (0, 0, 0.55), (0.34, 0.24, 0.12), ("armor", COL_ARMOR))

uarms, farms = {}, {}
for side, sx in (("L", -1), ("R", 1)):
    # pauldron: parented to the SPINE, not the arm — shoulder armor defines
    # the silhouette's peak width (0.455 of height) and must not swing away
    ball(f"pauldron.{side}", spine, (sx * SHOULDER_W, 0, SHOULDER_H), 0.13,
         ("armor", COL_ARMOR), squash=(1.0, 0.92, 0.86))
    ua = segment(f"uarm.{side}", spine, (sx * SHOULDER_W, 0, SHOULDER_H), UARM, R_UARM,
                 ("suit", COL_SUIT))
    # vine wrap on the character's left arm (screen-right when facing camera)
    fa_col = ("vine", COL_VINE) if side == "L" else ("suitdark", COL_SUIT_DARK)
    fa = segment(f"farm.{side}", ua, (0, 0, -UARM), FARM, R_FARM, fa_col)
    ball(f"hand.{side}", fa, (0, 0, -FARM), 0.07, ("glove", COL_GLOVE))
    uarms[side], farms[side] = ua, fa

head = bpy.data.objects.new("headroot", None)
bpy.context.collection.objects.link(head)
head.parent = spine
head.location = (0, 0, NECK_H)
# helmet dome: wide enough that the head block reads ~0.59 of the shoulder
# peak (the curated idle measures 10/17 occupancy) and low enough that it
# overlaps the collar — a visored HELMET, not a head wearing a beanie.
ball("skull", head, (0, 0, 0.06), 0.25, ("suit", COL_SUIT), squash=(0.96, 1.0, 0.98))
# dark visor plate across the face (front = -Y): the ranger's signature
# amber-lit visor band, inset from the dome's full width
box("visor", head, (0, -0.20, 0.03), (0.26, 0.09, 0.12), ("visor", COL_VISOR))
# orange cap crown: a PATCH on the crown of the dome, not a brimmed hat over
# it — NARROWER than the skull (0.40 vs 0.48) so it never overhangs, and only
# just proud of the dome's top so it still reads from the slight-high camera.
# Sizing is gated by accent fraction, not taste: the curated back views carry
# 0.030-0.034 of head-zone pixels as hot accent and consistency.py fails a
# back view over 0.09 — an overhanging crown measured 0.103 (a pancake hat on
# a different character), so this is the shape the identity gate allows.
ball("cap", head, (0, 0.02, 0.24), 0.20, ("cap", COL_CAP), squash=(1.0, 1.05, 0.42))

# ---- camera / light: the game's slight-high three-quarter read --------------
ELEV = math.radians(14)
DIST = 8.0
target = Vector((0, 0, 0.88))
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.location = (0, -DIST * math.cos(ELEV), target.z + DIST * math.sin(ELEV))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.30
bpy.context.scene.camera = cam

bpy.ops.object.light_add(type="SUN")
sun = bpy.context.object
sun.data.energy = 3.0
sun.rotation_euler = Vector((1.2, 1.6, -2.6)).to_track_quat("-Z", "Y").to_euler()
world = bpy.data.worlds.new("w")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.35, 0.38, 0.40, 1.0)
bg.inputs[1].default_value = 0.7
bpy.context.scene.world = world

sc = bpy.context.scene
engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
sc.render.resolution_x = sc.render.resolution_y = RES
sc.render.film_transparent = True
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"

# ---- the walk cycle: 8 explicit keyposes ------------------------------------
# Right-leg stride, degrees, forward = positive. 8 frames = contact / down /
# passing / up, then the mirrored half. (thigh, kneeFlex, footPitch)
R_LEG = [
    (27, 8, 12),    # 0 contact  (R heel strike, toes up)
    (20, 22, 0),    # 1 down     (weight drops onto R)
    (3, 6, 0),      # 2 passing  (R support nearly straight)
    (-14, 10, -18),  # 3 up       (R heel lifting, push-off)
]
L_LEG = [
    (-27, 15, -35),  # 0 (L trailing, toes pushing)
    (-20, 45, -25),  # 1 (L lifting)
    (-2, 65, -15),   # 2 (L passing under body, heel tucked)
    (14, 35, -5),    # 3 (L swinging forward)
]
HIP_YAW = [8, 6, 0, -4]      # right hip leads at contact R
BOB_ART = [-0.005, -0.012, 0.004, 0.012]  # artistic accent on top of FK ground
SWAY = [0.0, 0.012, 0.018, 0.012]         # weight over the stance (R) leg


def leg_drop(th_deg, knee_deg):
    """Vertical hip->ankle distance for a posed leg (sagittal FK)."""
    th = math.radians(th_deg)
    shin_angle = math.radians(th_deg - knee_deg)
    return THIGH * math.cos(th) + SHIN * math.cos(shin_angle)


def pose(f):
    k = f % 4
    if f < 4:
        r, l = R_LEG[k], L_LEG[k]
        hip_yaw, sway = HIP_YAW[k], SWAY[k]
    else:  # mirrored half: left leg does what right did
        r, l = L_LEG[k], R_LEG[k]
        hip_yaw, sway = -HIP_YAW[k], -SWAY[k]

    for side, (th, kn, ft) in (("R", r), ("L", l)):
        thighs[side].rotation_euler = (math.radians(-th), 0, 0)
        shins[side].rotation_euler = (math.radians(kn), 0, 0)
        boots[side].rotation_euler = (math.radians(-ft), 0, 0)

    # auto-ground: hips height so the lowest ankle sits just above the boot sole
    drop = max(leg_drop(*r[:2]), leg_drop(*l[:2]))
    hips.location = (sway, 0, 0.12 + drop + 0.03 + BOB_ART[k])
    hips.rotation_euler = (0, math.radians(-sway * 120), math.radians(hip_yaw))

    spine.rotation_euler = (math.radians(-6),  # forward lean (front = -Y)
                            math.radians(sway * 80),
                            math.radians(-hip_yaw * 0.7))
    head.rotation_euler = (math.radians(4), 0, math.radians(-hip_yaw * 0.3))

    # arms counter-swing (opposite the same-side leg), elbows carry through
    for side, leg in (("R", r), ("L", l)):
        arm_fwd = -0.75 * leg[0]
        elbow = 20 + 0.45 * max(0.0, arm_fwd)
        uarms[side].rotation_euler = (math.radians(-arm_fwd), 0, 0)
        farms[side].rotation_euler = (math.radians(-elbow), 0, 0)


for dname, yaw in DIRS.items():
    root.rotation_euler = (0, 0, math.radians(yaw))
    for f in range(FRAMES):
        pose(f)
        sc.render.filepath = f"{OUT}/walk-{dname}-{f}.png"
        bpy.ops.render.render(write_still=True)
        print(f"rendered walk-{dname}-{f}")

print("RIG_WALK_DONE")
