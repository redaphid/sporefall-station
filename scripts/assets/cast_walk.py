#!/usr/bin/env python3
"""Ship one character's `spritesheet.py --method video` run into the game, and gate it.

    python3 scripts/assets/cast_walk.py assemble RUN --kind mycologist --take n=RUN2 --out DIR  # merge takes
    python3 scripts/assets/cast_walk.py export RUN --kind mycologist   # both packs + manifests
    python3 scripts/assets/cast_walk.py sheet  RUN --kind mycologist   # beside the frog at 96 px
    python3 scripts/assets/cast_walk.py gate   RUN --kind mycologist   # every gate, one verdict

RUN is a finished video run dir (`.../video-s3`, holding sheet.json, frames/ and raw/).

export  a 96 px repack of the run's raws -> swampspace-hires/chars (the pack the game loads); a
        48 px repack of the same raws -> swampspace/chars (the pack consistency.py and verify.py read). Content 92 / 46,
        feet on canvas-2: the frog's numbers. Every archetype whose manifest keys already point at
        chars/<kind>-* gets the 50 keys <dir>-{idle,step,walk-0..7}.
sheet   rows = directions: the frog's row, then this character's, at 96 px on the game's
        background; plus an animated GIF of all five walks beside the frog's.
gate    every ship gate, thresholds in cast-gate-spec.json: loop seam; colour drift vs the
        s-idle; consistency.py <kind> --check; verify.py per frame (job = its direction, so
        "ne/n must not show a face" covers the walk frames too), --pairs and --same; the
        judge-sprite-mp4 metric gates on each loop; verify.py --style against the frog.
        Runs on what export wrote into the packs. Exit 0 only on all-PASS; gate.json has it all.

Outputs for a human go to $CAST_OUT/<kind>/ (default /mnt/d/tmp/cast-walks/<kind>/).
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
THEMES = os.path.join(REPO, "public", "themes")
PACKS = {"swampspace-hires": (96, 92), "swampspace": (48, 46)}
DIRS = ["s", "se", "e", "ne", "n"]
POSES = ["idle", "step"] + [f"walk-{i}" for i in range(8)]
BG = (12, 20, 22)  # manifest palette.background
OUT = os.environ.get("CAST_OUT", "/mnt/d/tmp/cast-walks")
JUDGE = os.environ.get("JUDGE_REPO", "/mnt/d/Projects/sporefall-art")
VLM = os.environ.get("OLLAMA", "http://127.0.0.1:18436")


def out_dir(kind):
    d = os.path.join(OUT, kind)
    os.makedirs(d, exist_ok=True)
    return d


def archetypes(kind):
    """Archetypes whose hi-res manifest keys already point at this kind's art."""
    m = json.load(open(os.path.join(THEMES, "swampspace-hires", "manifest.json")))
    return sorted({k.split(".")[1] for k, v in m["sprites"].items()
                   if k.startswith("char.") and isinstance(v, str) and v.startswith(f"chars/{kind}-")})


def cmd_export(a):
    run = os.path.abspath(a.run).rstrip("/")
    srcs = {}
    for pack, (px, content) in PACKS.items():  # re-post the run's raws at each pack's size, no GPU
        srcs[px] = f"{run}-{px}"
        subprocess.run([sys.executable, os.path.join(HERE, "spritesheet.py"), "repack", run, "--size", str(px),
                        "--content", str(content), "--to", srcs[px]], check=True, stdout=subprocess.DEVNULL)
    archs = a.arch or archetypes(a.kind)
    if not archs:
        raise SystemExit(f"no archetype's manifest points at chars/{a.kind}-*; pass --arch")
    for pack, (px, _) in PACKS.items():
        src = srcs[px]
        for d in DIRS:
            for p in POSES:
                f = f"{src}/frames/{a.kind}-{d}-{p}.png"
                im = Image.open(f)
                if im.size != (px, px):
                    raise SystemExit(f"{f} is {im.size}, want {px}x{px}")
                shutil.copyfile(f, os.path.join(THEMES, pack, "chars", f"{a.kind}-{d}-{p}.png"))
        mpath = os.path.join(THEMES, pack, "manifest.json")
        text = open(mpath).read()
        indent = len(text.splitlines()[1]) - len(text.splitlines()[1].lstrip())  # keep the file's own style
        m = json.loads(text)
        sprites = {}
        for k, v in m["sprites"].items():  # the arch's 50 keys go where its first key was, in dir/pose order
            arch = k.split(".")[1] if k.startswith("char.") else None
            if arch in archs:
                if f"char.{arch}.s-idle" not in sprites:
                    for d in DIRS:
                        for p in POSES:
                            sprites[f"char.{arch}.{d}-{p}"] = f"chars/{a.kind}-{d}-{p}.png"
                if k not in sprites:
                    sprites[k] = v  # a state we don't draw (attack-1 ...) stays as it was
            else:
                sprites[k] = v
        m["sprites"] = sprites
        with open(mpath, "w") as fh:
            json.dump(m, fh, indent=indent, ensure_ascii=False)
            fh.write("\n")
        print(f"{pack}: {len(DIRS) * len(POSES)} frames, keys for {', '.join(archs)}")


def cmd_assemble(a):
    """One run from several takes: `--take n=<run>` replaces a direction with another take's clip.
    Then the CLI's own automatic loop choice (--period 12:64) and a re-post onto the s-idle's
    colours (--palette-from). Nothing is copied over a take; the output is a new run dir."""
    base = os.path.abspath(a.run)
    takes = {d: base for d in DIRS}
    for t in a.take or []:
        d, _, path = t.partition("=")
        takes[d] = os.path.abspath(path)
    out = os.path.abspath(a.out)
    os.makedirs(f"{out}/raw", exist_ok=True)
    meta = json.load(open(f"{base}/sheet.json"))
    meta["takes"] = takes
    for d, src in takes.items():
        m = json.load(open(f"{src}/sheet.json"))
        meta["loops"][d] = m["loops"][d]
        for f in glob.glob(f"{src}/raw/{d}-*.png"):
            shutil.copyfile(f, f"{out}/raw/{os.path.basename(f)}")
        link = f"{out}/raw/walk-{d}"
        if not os.path.lexists(link):
            os.symlink(os.path.realpath(f"{src}/raw/walk-{d}"), link)
    inp = os.path.join(os.path.dirname(base), "input-1024.png")
    if os.path.exists(inp):
        shutil.copyfile(inp, os.path.join(os.path.dirname(out), "input-1024.png"))
    json.dump(meta, open(f"{out}/sheet.json", "w"), indent=1)
    ss = [sys.executable, os.path.join(HERE, "spritesheet.py"), "repack"]
    subprocess.run(ss + [out, "--period", a.period], check=True)
    subprocess.run(ss + [out, "--palette-from", f"{out}/frames/{a.kind}-s-idle.png", "--to", out + "-pal"], check=True,
                   stdout=subprocess.DEVNULL)
    print(f"-> {out}-pal (loops re-found, colours from its s-idle): export that")


def _row(kind, pack="swampspace-hires"):
    return [Image.open(os.path.join(THEMES, pack, "chars", f"{kind}-{d}-{p}.png")).convert("RGBA")
            for d in DIRS for p in POSES]


def cmd_sheet(a):
    """Frog row, then this character's row, per direction; frames at 96 px x2 on the game bg."""
    s, lab = 2, 14
    cell = 96 * s
    kinds = [a.ref, a.kind]
    W = cell * len(POSES) + 70
    H = (cell + lab) * len(DIRS) * len(kinds)
    im = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(im)
    y = 0
    for d in DIRS:
        for k in kinds:
            dr.text((4, y + lab + cell // 2), f"{k[:8]}\n{d}", fill=(200, 210, 200))
            for c, p in enumerate(POSES):
                f = os.path.join(THEMES, "swampspace-hires", "chars", f"{k}-{d}-{p}.png")
                if not os.path.exists(f):
                    continue
                fr = Image.open(f).convert("RGBA").resize((cell, cell), Image.NEAREST)
                im.paste(fr, (70 + c * cell, y + lab), fr)
                if y == 0 or k == kinds[0]:
                    dr.text((70 + c * cell + 4, y), p, fill=(150, 160, 150))
            y += cell + lab
    o = out_dir(a.kind)
    im.save(f"{o}/contact-96-vs-{a.ref}.png")
    # one animated strip: all five walks, the reference on top
    frames = []
    for i in range(8):
        fr = Image.new("RGB", (96 * s * 5, 96 * s * 2), BG)
        for r, k in enumerate(kinds):
            for c, d in enumerate(DIRS):
                f = os.path.join(THEMES, "swampspace-hires", "chars", f"{k}-{d}-walk-{i}.png")
                if os.path.exists(f):
                    p = Image.open(f).convert("RGBA").resize((96 * s, 96 * s), Image.NEAREST)
                    fr.paste(p, (c * 96 * s, r * 96 * s), p)
        frames.append(fr)
    # anim.walk = 4: the game advances a walk frame every 4 ticks (~15 fps at 60 Hz)
    frames[0].save(f"{o}/walk-96-vs-{a.ref}.gif", save_all=True, append_images=frames[1:], duration=67, loop=0)
    print(f"{o}/contact-96-vs-{a.ref}.png\n{o}/walk-96-vs-{a.ref}.gif")


def _tail(cmd, env=None):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, env={**os.environ, **(env or {})})
    return r.returncode, (r.stdout + r.stderr).strip()


def judge_loops(run, kind):
    """judge-sprite-mp4's metric gates (sporefall-art sprites/judge.py) on each loop."""
    sys.path.insert(0, JUDGE)
    from sprites import judge  # noqa: E402
    meta = json.load(open(f"{run}/sheet.json"))
    res = {}
    for d in DIRS:
        lp = meta["loops"][d]
        paths = sorted(glob.glob(f"{run}/raw/walk-{d}/*.png"))[lp["start"]:lp["start"] + lp["period"]]
        frames = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]
        rep = judge.measure(frames)
        gates = {"identity_drift": rep["identity_drift"] <= judge.GATES["identity_drift"],
                 "head_drift": rep["head_drift"] <= judge.GATES["head_drift"],
                 "flicker": rep["flicker"] <= judge.GATES["flicker"],
                 "sharpness": rep["sharpness"] >= judge.GATES["sharpness_min"],
                 "coverage_jitter": rep["coverage_jitter"] <= judge.GATES["coverage_jitter"]}
        o = os.path.join(out_dir(kind), "judge", d)
        os.makedirs(o, exist_ok=True)
        judge._sheet(frames, os.path.join(o, "sheet.png"))
        judge._sheet(frames, os.path.join(o, "heads.png"), head=True)
        res[d] = {"pass": all(gates.values()), "gates": gates, "loop": lp,
                  **{k: rep[k] for k in ("identity_drift", "head_drift", "flicker", "sharpness", "coverage_jitter")}}
    return res


SPEC = json.load(open(os.path.join(HERE, "cast-gate-spec.json")))


def _cols(path):
    a = np.asarray(Image.open(path).convert("RGBA"))
    px = a[a[..., 3] > 128][:, :3].astype(int)
    cols, counts = np.unique(px, axis=0, return_counts=True)
    return cols, counts


def colour_drift(kind, pack="swampspace-hires"):
    """Per direction: share of pixels in colours far from every colour of the s-idle anchor."""
    c = SPEC["colour"]
    chars = os.path.join(THEMES, pack, "chars")
    acols, acounts = _cols(os.path.join(chars, f"{kind}-{c['anchor']}.png"))
    dom = acols[acounts >= c["anchor_share"] * acounts.sum()]
    res = {}
    for d in DIRS:
        tot = {}
        for p in POSES:
            for col, n in zip(*_cols(os.path.join(chars, f"{kind}-{d}-{p}.png"))):
                tot[tuple(col)] = tot.get(tuple(col), 0) + int(n)
        T = sum(tot.values())
        far = {col: n / T for col, n in tot.items() if n / T >= c["min_share"]
               and np.sqrt(((dom - np.array(col)) ** 2).sum(1)).min() > c["far_rgb"]}
        drift = sum(far.values())
        res[d] = {"pass": drift <= c["drift_max"], "drift": round(drift, 4),
                  "far": {"#%02x%02x%02x" % col: round(v, 4) for col, v in sorted(far.items(), key=lambda x: -x[1])}}
    return res


def cmd_gate(a):
    """All five ship gates, thresholds from cast-gate-spec.json. Exit 0 only if every one passes."""
    run, kind = os.path.abspath(a.run), a.kind
    out, ok = {"kind": kind, "run": run, "spec": SPEC}, {}

    def say(name, passed, detail):
        ok[name] = passed
        print(f"{'PASS' if passed else 'FAIL'}  {name:22s} {detail}", flush=True)

    loops = json.load(open(f"{run}/sheet.json"))["loops"]
    out["seam"] = {d: loops[d]["seam"] for d in DIRS}
    bad = {d: v for d, v in out["seam"].items() if v > SPEC["seam_max"]}
    say("1 loop seam", not bad, f"max {SPEC['seam_max']}: " + " ".join(f"{d} {v}" for d, v in out["seam"].items()))

    out["colour"] = colour_drift(kind)
    say("2 colour vs s-idle", all(r["pass"] for r in out["colour"].values()),
        f"max {SPEC['colour']['drift_max']}: " + " ".join(f"{d} {r['drift']}" + (f" {list(r['far'])[:2]}" if not r["pass"] else "")
                                                     for d, r in out["colour"].items()))

    rc, txt = _tail([sys.executable, "consistency.py", kind, "--check"])
    out["consistency"] = txt.splitlines()[-12:]
    say("3 silhouette spec", rc == 0, txt.splitlines()[-1] + ("" if rc == 0 else "  e.g. " + txt.splitlines()[0][5:90]))

    env = {"OLLAMA": VLM, "VERIFY_THEME": SPEC["verify"]["theme"]}
    fails = []
    for d in DIRS:
        files = [os.path.join(THEMES, SPEC["verify"]["theme"], "chars", f"{kind}-{d}-{p}.png") for p in POSES]
        rc, txt = _tail([sys.executable, "verify.py", *files, "--job", f"char.{kind}.{d}-idle"], env)
        fails += [ln[5:90] for ln in txt.splitlines() if ln.startswith("FAIL")]
    out["verify_frames"] = fails
    say("4a VLM facing/no-face", not fails, f"{len(fails)} of {len(DIRS) * len(POSES)} frames fail" +
        (f": {fails[0]}" if fails else ""))
    for mode in ("--pairs", "--same"):
        rc, txt = _tail([sys.executable, "verify.py", mode, "--kind", kind], env)
        out["verify" + mode[1:]] = txt.splitlines()[-12:]
        say(f"4b VLM {mode[2:]}", rc == 0, txt.splitlines()[-1])

    out["judge"] = judge_loops(run, kind)
    say("5 judge-sprite-mp4", all(r["pass"] for r in out["judge"].values()),
        " ".join(f"{d} {'ok' if r['pass'] else 'FAIL:' + ','.join(k for k, v in r['gates'].items() if not v)}"
                 for d, r in out["judge"].items()))

    senv = {**env, "VERIFY_THEME": SPEC["style"]["theme"], "STYLE_ANCHORS": ",".join(SPEC["style"]["anchors"])}
    rc, txt = _tail([sys.executable, "verify.py", "--style", "--kind", kind], senv)
    out["style"] = txt.splitlines()[-12:]
    say("6 style vs frog", rc == 0, txt.splitlines()[-1])

    out["pass"] = all(ok.values())
    out["gates"] = ok
    path = os.path.join(out_dir(kind), "gate.json")
    json.dump(out, open(path, "w"), indent=1, default=float)
    print(f"GATES {'PASS' if out['pass'] else 'FAIL'} ({sum(ok.values())}/{len(ok)}) -> {path}")
    sys.exit(0 if out["pass"] else 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("assemble", "export", "sheet", "gate"):
        p = sub.add_parser(name)
        p.add_argument("run")
        p.add_argument("--kind", required=True)
        if name == "assemble":
            p.add_argument("--take", nargs="*", help="dir=<other run>, e.g. n=runs/x/take2-n/video-s11")
            p.add_argument("--out", required=True)
            p.add_argument("--period", default="12:64")
        if name == "export":
            p.add_argument("--arch", nargs="+", help="archetypes to key (default: those already using the kind)")
        if name == "sheet":
            p.add_argument("--ref", default="frog-settler")
    a = ap.parse_args()
    {"assemble": cmd_assemble, "export": cmd_export, "sheet": cmd_sheet, "gate": cmd_gate}[a.cmd](a)


if __name__ == "__main__":
    main()
