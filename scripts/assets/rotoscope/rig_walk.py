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
COL_CAP = lin("#ff9032")       # orange-amber cap
COL_VISOR = lin("#1c1420")     # dark visor face
COL_BOOT = lin("#6b4d26")      # tan-brown boots
COL_STRAP = lin("#4a3419")     # leather chest strap
COL_PACK = lin("#163a3e")      # back pack
COL_GLOVE = lin("#23282e")     # gloves
COL_VINE = lin("#4c6b28")      # vine wrap on one arm

# ---- proportions (lithe humanoid, matches the curated vine-ranger) ----------
HIP_H = 0.95        # nominal hip height (auto-grounded per frame)
THIGH, SHIN = 0.44, 0.44
HIP_W = 0.09        # hip joint x offset
SHOULDER_W = 0.20
UARM, FARM = 0.30, 0.27
SPINE_OFF = 0.07    # hips empty -> spine origin
SHOULDER_H = 0.36   # spine origin -> shoulder joints
NECK_H = 0.475      # spine origin -> head origin


def mat(name, color):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.85
    return m


MATS = {}


def M(name, color):
    if name not in MATS:
        MATS[name] = mat(name, color)
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

pelvis = box("pelvis", hips, (0, 0, 0.02), (0.26, 0.16, 0.14), ("suit", COL_SUIT))

thighs, shins, boots = {}, {}, {}
for side, sx in (("L", -1), ("R", 1)):
    th = segment(f"thigh.{side}", hips, (sx * HIP_W, 0, -0.03), THIGH, 0.062,
                 ("suit", COL_SUIT))
    sh = segment(f"shin.{side}", th, (0, 0, -THIGH), SHIN, 0.052,
                 ("suitdark", COL_SUIT_DARK))
    bt = box(f"boot.{side}", sh, (0, 0, -SHIN), (0.13, 0.24, 0.14),
             ("boot", COL_BOOT), shift=(0, -0.05, 0.02))  # toe toward -Y (front)
    thighs[side], shins[side], boots[side] = th, sh, bt

spine = bpy.data.objects.new("spine", None)
bpy.context.collection.objects.link(spine)
spine.parent = hips
spine.location = (0, 0, SPINE_OFF)

box("torso", spine, (0, 0, 0.20), (0.32, 0.17, 0.34), ("suit", COL_SUIT))
# leather chest strap: thin diagonal slab across the front
strap = box("strap", spine, (0, -0.093, 0.20), (0.30, 0.02, 0.07), ("strap", COL_STRAP))
strap.rotation_euler = (0, math.radians(28), 0)
box("pack", spine, (0, 0.13, 0.22), (0.24, 0.12, 0.26), ("pack", COL_PACK))

uarms, farms = {}, {}
for side, sx in (("L", -1), ("R", 1)):
    ua = segment(f"uarm.{side}", spine, (sx * SHOULDER_W, 0, SHOULDER_H), UARM, 0.05,
                 ("suit", COL_SUIT))
    # vine wrap on the character's left arm (screen-right when facing camera)
    fa_col = ("vine", COL_VINE) if side == "L" else ("suitdark", COL_SUIT_DARK)
    fa = segment(f"farm.{side}", ua, (0, 0, -UARM), FARM, 0.045, fa_col)
    ball(f"hand.{side}", fa, (0, 0, -FARM), 0.055, ("glove", COL_GLOVE))
    uarms[side], farms[side] = ua, fa

head = bpy.data.objects.new("headroot", None)
bpy.context.collection.objects.link(head)
head.parent = spine
head.location = (0, 0, NECK_H)
ball("skull", head, (0, 0, 0.05), 0.145, ("suit", COL_SUIT), squash=(0.92, 0.95, 1.0))
# dark visor plate on the face (front = -Y)
box("visor", head, (0, -0.115, 0.03), (0.17, 0.07, 0.13), ("visor", COL_VISOR))
# orange cap: squashed sphere sitting up-back on the skull
ball("cap", head, (0, 0.025, 0.135), 0.16, ("cap", COL_CAP), squash=(1.0, 1.15, 0.62))

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
