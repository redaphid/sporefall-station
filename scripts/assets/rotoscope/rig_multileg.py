#!/usr/bin/env python3
"""Periodic many-legged walker proxy: the mireclaw-stalker body plan on an alternating-tetrapod gait.

Wan I2V steps each of eight legs on its own rhythm, so its clips hold no loop point. This rig is
periodic by construction: every foot's path is a function of phase, and frame P equals frame 0
exactly. Its depth video drives Wan 2.2 Fun-Control (the look comes from the character keyframe);
its colour-blocked frames are the per-frame tracer's init.

Runs INSIDE Blender (Windows binary, D:/ paths), CPU Cycles only (the GPU is shared):
  blender.exe -b -P rig_multileg.py -- --out D:/tmp/cast-walks/rnd-multileg/proxy --dirs se --frames 16

Output per direction: <out>/<dir>/depth-NN.png (white near, far body 0.2, background black),
<out>/<dir>/color-NN.png (RGBA, transparent), <out>/<dir>/joints-NN.json (every joint projected to
pixels, with its view depth). Frame NN is phase NN/frames of one full cycle.

--mode depth (default) renders every mesh. --mode legs hides the carapace, head and crest, so the depth
carries only the legs and the keyframe alone supplies the body. --mode skeleton renders nothing and only
writes the joints; skeleton.py draws them as a stick control.
"""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = arg("--out", "D:/tmp/cast-walks/rnd-multileg/proxy").rstrip("/")
DIRS_ALL = {"s": 0.0, "se": 45.0, "e": 90.0, "ne": 135.0, "n": 180.0}
DIRS = [d for d in arg("--dirs", "se").split(",") if d]
FRAMES = int(arg("--frames", "16"))
W, H = int(arg("--w", "848")), int(arg("--h", "480"))
ELEV = math.radians(float(arg("--elev", "30")))
ORTHO = float(arg("--ortho", "6.4"))
AIM_Z = float(arg("--aim-z", "0.75"))
STRIDE = float(arg("--stride", "0.55"))
LIFT = float(arg("--lift", "0.32"))
DUTY = float(arg("--duty", "0.5"))
SAMPLES = int(arg("--samples", "16"))
MODE = arg("--mode", "depth")
assert MODE in ("depth", "legs", "skeleton"), MODE


def lin(hexstr):
    h = hexstr.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4)) + (1.0,)


COLORS = {"shell": lin("#2e8f8c"), "shell_dark": lin("#1d5a5e"), "leg": lin("#27767a"),
          "tip": lin("#26262b"), "bone": lin("#c9b48a"), "eye": lin("#9a3fc4"), "belly": lin("#3a4448")}

# Body plan in the creature's frame: forward = -Y (faces the camera at yaw 0), up = +Z, ground z = 0.
BODY_Z = float(arg("--body-z", "1.05"))
FEMUR, TIBIA = float(arg("--femur", "1.0")), float(arg("--tibia", "1.35"))
LEG_R = float(arg("--leg-r", "0.085"))
SHELL = tuple(float(v) for v in arg("--shell", "0.55,0.95,0.42").split(","))
POLE_UP = float(arg("--pole-up", "1.0"))
SPINE_L = float(arg("--spine-l", "0.28"))
# (hip y, rest-foot angle from lateral in degrees, + = forward), front to back, one side
LEGS = [(-0.55, 50), (-0.2, 18), (0.15, -14), (0.5, -42)]
HIP_X, FOOT_R = float(arg("--hip-x", "0.34")), float(arg("--foot-r", "1.25"))


def material(name, color):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.8
    return m


def depth_material(near, far):
    """Emission = mapped view depth, so the depth pass is anti-aliased and needs no compositor."""
    m = bpy.data.materials.new("depth")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    cam = nt.nodes.new("ShaderNodeCameraData")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.clamp = True
    mr.inputs["From Min"].default_value = near
    mr.inputs["From Max"].default_value = far
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.2
    # pre-compensate the sRGB view transform so the PNG stores the mapped depth linearly
    gam = nt.nodes.new("ShaderNodeMath")
    gam.operation = "POWER"
    gam.inputs[1].default_value = 2.2
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(cam.outputs["View Z Depth"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], gam.inputs[0])
    nt.links.new(gam.outputs["Value"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


MATS = {k: material(k, c) for k, c in COLORS.items()}

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
root = bpy.data.objects.new("root", None)
bpy.context.collection.objects.link(root)
body = bpy.data.objects.new("body", None)
bpy.context.collection.objects.link(body)
body.parent = root
MESHES = []


def adopt(ob, name, mat, parent):
    ob.name = name
    ob.data.materials.append(MATS[mat])
    ob.parent = parent
    MESHES.append(ob)
    return ob


def ellipsoid(name, parent, loc, axes, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=32, ring_count=16)
    ob = bpy.context.object
    ob.scale = axes
    ob.location = loc
    return adopt(ob, name, mat, parent)


def cone(name, parent, loc, r_base, r_tip, length, mat, rot=(0, 0, 0)):
    """Cone with its base at the origin, pointing +Z."""
    bpy.ops.mesh.primitive_cone_add(radius1=r_base, radius2=r_tip, depth=length, vertices=12)
    ob = bpy.context.object
    ob.data.transform(Matrix.Translation((0, 0, length / 2)))
    ob.location = loc
    ob.rotation_euler = rot
    return adopt(ob, name, mat, parent)


# carapace: long low dome, darker belly under it, wedge head in front
ellipsoid("carapace", body, (0, 0.1, 0.12), SHELL, "shell")
ellipsoid("belly", body, (0, 0.05, -0.1), (0.45, 0.8, 0.22), "belly")
ellipsoid("abdomen", body, (0, 0.95, 0.05), (0.36, 0.42, 0.3), "shell_dark")
ellipsoid("head", body, (0, -0.82, 0.1), (0.4, 0.42, 0.3), "shell")
for sx in (-1, 1):
    ellipsoid(f"eye{sx}", body, (sx * 0.26, -1.05, 0.18), (0.08, 0.08, 0.08), "eye")
    cone(f"fang{sx}", body, (sx * 0.14, -1.14, -0.02), 0.06, 0.006, 0.36, "bone", rot=(math.radians(165), 0, 0))
# crest: a row of curved bone spines on the dorsal ridge, raked back, plus two short side rows
N_SP = int(arg("--spines", "14"))
for i in range(N_SP):
    t = i / (N_SP - 1)
    y = -0.7 + 1.55 * t
    z = 0.12 + SHELL[2] * math.sqrt(max(0.0, 1 - ((y - 0.1) / SHELL[1]) ** 2)) - 0.05
    cone(f"spine{i}", body, (0, y, z), 0.1, 0.012, SPINE_L + 0.12 * math.sin(math.pi * t), "bone",
         rot=(math.radians(-35), 0, 0))
    if 1 <= i <= N_SP - 2:
        for sx in (-1, 1):
            cone(f"spine{i}.{sx}", body, (sx * SHELL[0] * 0.55, y, z - SHELL[2] * 0.25), 0.075, 0.01, SPINE_L * 0.6, "bone",
                 rot=(math.radians(-30), math.radians(sx * 45), 0))


FEM_N, TIB_N, TIP_N = 3, 6, 3   # sub-pieces per bone; the last TIP_N of the tibia are the dark hooked tip
BOW = float(arg("--bow", "0.18"))     # femur bows out/up by this fraction of its chord
CURL = float(arg("--curl", "0.22"))   # tibia bows out, then hooks in, by this fraction of its chord


def piece(name, r0, r1, mat):
    """A unit-length tapered piece along -Z from its origin (r0 at the origin, r1 at the far end), plus a
    ball at its origin so a chain of pieces reads as one curved limb. Scaled to its chord each frame."""
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r0, depth=1.0, vertices=14)
    ob = bpy.context.object
    ob.data.transform(Matrix.Translation((0, 0, -0.5)))
    ob.rotation_mode = "QUATERNION"
    adopt(ob, name, mat, root)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r0 * 1.06, segments=12, ring_count=8)
    j = bpy.context.object
    adopt(j, name + ".j", mat, root)
    return ob, j


def chain(name, radii, mats):
    return [piece(f"{name}.{k}", radii[k], radii[k + 1], mats[k]) for k in range(len(mats))]


# legs: (side, hip, rest foot, phase, femur chain, tibia chain, spur). Alternating tetrapod: L0 R1 L2 R3 swing together.
LEG_SET = []
for sx, side in ((-1, "L"), (1, "R")):
    for i, (hy, ang) in enumerate(LEGS):
        hip = Vector((sx * HIP_X, hy, BODY_Z - 0.08))
        a = math.radians(ang)
        foot = Vector((hip.x + sx * FOOT_R * math.cos(a), hip.y - FOOT_R * math.sin(a), 0.0))
        phase = 0.0 if (i % 2 == 0) == (side == "L") else 0.5
        fr = [LEG_R * (1.15 - 0.2 * k / FEM_N) for k in range(FEM_N + 1)]
        tr = [LEG_R * (0.95 - 0.55 * k / TIB_N) for k in range(TIB_N)] + [0.012]
        fem = chain(f"femur.{side}{i}", fr, ["leg"] * FEM_N)
        tib = chain(f"tibia.{side}{i}", tr, ["leg"] * (TIB_N - TIP_N) + ["tip"] * TIP_N)
        spur = cone(f"spur.{side}{i}", root, (0, 0, 0), LEG_R * 0.55, 0.008, 0.34, "bone")
        spur.rotation_mode = "QUATERNION"
        LEG_SET.append((sx, hip, foot, phase, fem, tib, spur))


def bez(ps, t):
    """de Casteljau: any-order Bezier through control points ps."""
    while len(ps) > 1:
        ps = [a.lerp(b, t) for a, b in zip(ps, ps[1:])]
    return ps[0]


def lay(pieces, pts):
    for (ob, j), a, b in zip(pieces, pts, pts[1:]):
        aim(ob, a, b)
        ob.scale = (1, 1, (b - a).length)
        j.location = a


def ease(u):
    return 0.5 - 0.5 * math.cos(math.pi * u)


def foot_at(rest, phase):
    """Stance: the foot slides back at constant speed (walking in place). Swing: it arcs forward."""
    fwd = Vector((0, -1, 0))
    if phase < DUTY:
        s = STRIDE * (0.5 - phase / DUTY)
        z = 0.0
    else:
        u = (phase - DUTY) / (1 - DUTY)
        s = STRIDE * (-0.5 + ease(u))
        z = LIFT * math.sin(math.pi * u)
    return rest + fwd * s + Vector((0, 0, z))


def aim(ob, a, b):
    ob.location = a
    ob.rotation_quaternion = Vector((0, 0, -1)).rotation_difference((b - a).normalized())


JOINTS = {}
# body axis in the body's frame, head to tail: fang tips, head, carapace middle, abdomen end
BODY_AXIS = [(0, -1.14, -0.3), (0, -0.82, 0.1), (0, 0.1, 0.3), (0, 1.35, 0.05)]


def pose(t):
    """t in [0, 1): one full gait cycle. Body height bobs twice per cycle (once per tetrapod swap)."""
    body.location = (0, 0, BODY_Z + 0.025 * math.cos(4 * math.pi * t))
    for n, (sx, hip, foot, phase, fem, tib, spur) in enumerate(LEG_SET):
        h = hip + Vector((0, 0, body.location.z - BODY_Z))
        f = foot_at(foot, (t + phase) % 1.0)
        d = f - h
        dist = min(max(d.length, abs(FEMUR - TIBIA) + 1e-3), FEMUR + TIBIA - 1e-3)
        u = d.normalized()
        out = Vector((foot.x - hip.x, foot.y - hip.y, 0)).normalized()
        pole = (out + Vector((0, 0, POLE_UP))).normalized()
        v = (pole - u * pole.dot(u)).normalized()
        x = (FEMUR ** 2 - TIBIA ** 2 + dist ** 2) / (2 * dist)
        knee = h + u * x + v * math.sqrt(max(0.0, FEMUR ** 2 - x ** 2))
        tip = h + u * dist
        up = Vector((0, 0, 1))
        c1 = (h + knee) / 2 + (out * 0.6 + up) .normalized() * BOW * (knee - h).length
        lay(fem, [bez([h, c1, knee], k / FEM_N) for k in range(FEM_N + 1)])
        seg = (tip - knee).length
        c2 = knee + (tip - knee) * 0.35 + out * CURL * seg
        c3 = tip + out * CURL * 1.1 * seg + up * 0.35 * CURL * seg
        tib_pts = [bez([knee, c2, c3, tip], k / TIB_N) for k in range(TIB_N + 1)]
        lay(tib, tib_pts)
        JOINTS[f"{'L' if sx < 0 else 'R'}{n % len(LEGS)}"] = [h, knee, tib_pts[TIB_N // 2], tip]
        spur.location = knee
        spur.rotation_quaternion = Vector((0, 0, 1)).rotation_difference((out * 1.0 - up * 0.5 - (knee - h).normalized() * 0.3).normalized())


sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = False
sc.render.resolution_x, sc.render.resolution_y = W, H
sc.render.image_settings.file_format = "PNG"
sc.view_settings.view_transform = "Standard"

target = Vector((0, 0, AIM_Z))
DIST = 12.0
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.location = (0, -DIST * math.cos(ELEV), target.z + DIST * math.sin(ELEV))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.type = "ORTHO"
cam.data.ortho_scale = ORTHO
sc.camera = cam

bpy.ops.object.light_add(type="SUN")
sun = bpy.context.object
sun.data.energy = 3.5
sun.rotation_euler = Vector((0.6, 0.9, -1.8)).to_track_quat("-Z", "Y").to_euler()
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.5, 0.52, 0.55, 1.0)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.8
sc.world = world


def depth_window():
    """Nearest/farthest view depth of any vertex over every frame and direction, padded 3%."""
    fwd = (target - cam.location).normalized()
    lo, hi = 1e9, -1e9
    for yaw in (DIRS_ALL[d] for d in DIRS):
        root.rotation_euler = (0, 0, math.radians(yaw))
        for f in range(FRAMES):
            pose(f / FRAMES)
            bpy.context.view_layer.update()
            for ob in MESHES:
                mw = ob.matrix_world
                for vtx in ob.data.vertices:
                    z = (mw @ vtx.co - cam.location).dot(fwd)
                    lo, hi = min(lo, z), max(hi, z)
    pad = 0.03 * (hi - lo)
    return lo - pad, hi + pad


if MODE == "legs":
    for ob in [ob for ob in MESHES if ob.parent == body]:
        ob.hide_render = True
        MESHES.remove(ob)
near, far = depth_window()
DEPTH_MAT = depth_material(near, far)
print(f"depth window {near:.3f}..{far:.3f}")


BASE_MAT = {ob.name: ob.data.materials[0] for ob in MESHES}


def dump_joints(path):
    """Each joint as [x px, y px, view depth]: the body axis, then per leg hip, knee, mid-tibia, tip."""
    bpy.context.view_layer.update()

    def px(v):
        c = world_to_camera_view(sc, cam, v)
        return [round(c.x * W, 2), round((1 - c.y) * H, 2), round(c.z, 4)]
    js = {"w": W, "h": H, "body": [px(body.matrix_world @ Vector(p)) for p in BODY_AXIS],
          "legs": {k: [px(root.matrix_world @ v) for v in pts] for k, pts in JOINTS.items()}}
    with open(path, "w") as f:
        json.dump(js, f)


def render(path, depth):
    for ob in MESHES:
        ob.data.materials[0] = DEPTH_MAT if depth else BASE_MAT[ob.name]
    sc.render.film_transparent = not depth
    sc.render.image_settings.color_mode = "RGB" if depth else "RGBA"
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.0 if depth else 0.8
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


ONLY = [int(v) for v in arg("--only", "").split(",") if v]
for d in DIRS:
    root.rotation_euler = (0, 0, math.radians(DIRS_ALL[d]))
    for f in (ONLY or range(FRAMES)):
        pose(f / FRAMES)
        os.makedirs(f"{OUT}/{d}", exist_ok=True)
        dump_joints(f"{OUT}/{d}/joints-{f:02d}.json")
        if MODE == "skeleton":
            continue
        if not ONLY:
            render(f"{OUT}/{d}/depth-{f:02d}.png", depth=True)
        render(f"{OUT}/{d}/color-{f:02d}.png", depth=False)
        print(f"rendered {d} {f}")
print("RIG_MULTILEG_DONE")
