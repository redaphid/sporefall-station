#!/usr/bin/env python3
"""Ship one character's `spritesheet.py --method video` run into the game, and gate it.

    python3 scripts/assets/cast_walk.py assemble RUN --kind mycologist --take n=RUN2 --out DIR  # merge takes
    python3 scripts/assets/cast_walk.py export RUN --kind mycologist   # both packs + manifests
    python3 scripts/assets/cast_walk.py sheet  RUN --kind mycologist   # beside the frog at 96 px
    python3 scripts/assets/cast_walk.py gate   RUN --kind mycologist   # every gate, one verdict
    python3 scripts/assets/cast_walk.py strip --kind mycologist        # flows out of the shipped frames

RUN is a finished video run dir (`.../video-s3`, holding sheet.json, frames/ and raw/).

export  a 96 px repack of the run's raws -> swampspace-hires/chars (the pack the game loads); a
        48 px repack of the same raws -> swampspace/chars (the pack consistency.py and verify.py read). Content 92 / 46,
        feet on canvas-2: the frog's numbers. Every archetype whose manifest keys already point at
        chars/<kind>-* gets the 50 keys <dir>-{idle,step,walk-0..7}. Then strip.
strip   each direction's embedded ComfyUI flow -> flows/cast/<kind>/<dir>.json (+ <dir>_api.json, the
        prompt), then drop every text chunk from the shipped frames; the other chunks stay byte for byte,
        so the pixels can't change. ~25 KB a frame that would otherwise ship in the web bundle and the APK.
sheet   rows = directions: the frog's row, then this character's, at 96 px on the game's
        background; plus an animated GIF of all five walks beside the frog's.
gate    every ship gate, thresholds in cast-gate-spec.json: loop seam; colour drift vs the
        s-idle; consistency.py <kind> --check; verify.py per frame (job = its direction, so
        "ne/n must not show a face" covers the walk frames too), --pairs and --same; the
        judge-sprite-mp4 metric gates on each loop, with boil in place of flicker; verify.py
        --style against the frog; every pixel on the pack's locked palette.
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
FLOWS = os.path.join(HERE, "flows", "cast")  # outside public/: kept in the repo, never shipped
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
    strip_flows(a.kind)


def _without_text(png):
    """The PNG minus its tEXt/iTXt/zTXt chunks; every other chunk is kept byte for byte."""
    out, i = [png[:8]], 8
    while i < len(png):
        end = i + 12 + int.from_bytes(png[i:i + 4], "big")
        if png[i + 4:i + 8] not in (b"tEXt", b"iTXt", b"zTXt"):
            out.append(png[i:end])
        i = end
    return b"".join(out)


def strip_flows(kind):
    """Move the flow the shipped frames of each direction embed to flows/cast/<kind>/, then strip the frames.
    The flow is written before any frame loses it; a direction whose frames are already bare keeps its files."""
    os.makedirs(os.path.join(FLOWS, kind), exist_ok=True)
    for d in DIRS:
        files = [os.path.join(THEMES, pack, "chars", f"{kind}-{d}-{p}.png") for pack in PACKS for p in POSES]
        flows = {tuple(sorted(Image.open(f).text.items())) for f in files} - {()}
        if len(flows) > 1:
            raise SystemExit(f"{kind} {d}: the frames carry {len(flows)} different flows, want one per direction")
        if flows:
            text = dict(flows.pop())
            if set(text) != {"workflow", "prompt"}:
                raise SystemExit(f"{kind} {d}: text chunks {sorted(text)}, want exactly workflow + prompt")
            for name, key in ((f"{d}.json", "workflow"), (f"{d}_api.json", "prompt")):
                with open(os.path.join(FLOWS, kind, name), "w", encoding="latin-1") as fh:
                    fh.write(text[key])
        for f in files:
            png = open(f, "rb").read()
            bare = _without_text(png)
            if bare != png:
                with open(f, "wb") as fh:
                    fh.write(bare)
    print(f"{kind}: flows in {os.path.relpath(os.path.join(FLOWS, kind), REPO)}, frames stripped")


def cmd_strip(a):
    for kind in a.kind:
        strip_flows(kind)


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
        for f in glob.glob(f"{src}/raw/{d}-*.png") + glob.glob(f"{src}/raw/{d}-*.mp4") + \
                glob.glob(f"{src}/flow-{d}.json") + glob.glob(f"{src}/flow-{d}_api.json"):
            dst = f"{out}/raw/{os.path.basename(f)}" if "/raw/" in f else f"{out}/{os.path.basename(f)}"
            shutil.copyfile(f, dst)  # the flow that made this direction travels with its frames
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


def _flow_of(kind, d="s"):
    """tEXt prompt/workflow chunks from <kind>'s <d> flow in flows/cast/, for images built from its frames."""
    from PIL import PngImagePlugin
    wf, api = (os.path.join(FLOWS, kind, f"{d}{s}.json") for s in ("", "_api"))
    if not os.path.exists(wf):
        return None
    pi = PngImagePlugin.PngInfo()
    pi.add_text("prompt", open(api, encoding="latin-1").read())
    pi.add_text("workflow", open(wf, encoding="latin-1").read())
    return pi


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
    im.save(f"{o}/contact-96-vs-{a.ref}.png", pnginfo=_flow_of(a.kind))
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


def _judge():
    sys.path.insert(0, JUDGE)
    from sprites import judge  # noqa: E402
    return judge


BOIL_N, BOIL_DOWN, BOIL_R = 16, 2, 6


def boil(frames):
    """Texture that re-rolls between frames, per unit of the sprite's own contrast.

    Each frame is matched to the next one within BOIL_R px (after BOIL_DOWN x downsampling), so
    limbs that move are matched away and what is left is change in place: boil. Dividing by the
    mean in-silhouette gradient makes a cream suit with a dark visor comparable with a brown cloak.
    Callers pass BOIL_N frames per stride, so a fast walker and a slow one move alike per step.
    """
    judge = _judge()
    k, r = BOIL_DOWN, BOIL_R
    fs = [f[:f.shape[0] // k * k, :f.shape[1] // k * k].reshape(f.shape[0] // k, k, f.shape[1] // k, k, 3).mean((1, 3))
          for f in frames]
    ms = [judge._mask(f) for f in fs]
    res = []
    for a, b, ma, mb in zip(fs, fs[1:], ms, ms[1:]):
        pa = np.pad(a, ((r, r), (r, r), (0, 0)), mode="edge")
        best = np.full(ma.shape, np.inf)
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                best = np.minimum(best, np.abs(pa[r + dy:r + dy + a.shape[0], r + dx:r + dx + a.shape[1]] - b).mean(2))
        res.append(best[ma | mb].mean())
    contrast = [(np.abs(np.diff(f, axis=1)).mean(2)[m[:, 1:]].mean() + np.abs(np.diff(f, axis=0)).mean(2)[m[1:]].mean()) / 2
                for f, m in zip(fs, ms)]
    return round(float(np.mean(res) / np.mean(contrast)), 4)


def _rgb(paths):
    return [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]


def judge_loop(paths, start, period):
    """Gate 5 on one loop of raw video frames: sprites.judge metrics, with boil in place of flicker."""
    judge, lim = _judge(), SPEC["judge"]
    frames = _rgb(paths[start:start + period])
    n = min(BOIL_N, period)
    rep = judge.measure(frames)
    rep["boil"] = boil(_rgb([paths[start + round(i * period / n)] for i in range(n)]))
    gates = {"identity_drift": rep["identity_drift"] <= judge.GATES["identity_drift"],
             "head_drift": rep["head_drift"] <= lim["head_drift_max"],
             "boil": rep["boil"] <= lim["boil_max"],
             "sharpness": rep["sharpness"] >= judge.GATES["sharpness_min"],
             "coverage_jitter": rep["coverage_jitter"] <= judge.GATES["coverage_jitter"]}
    return frames, {"pass": all(gates.values()), "gates": gates,
                    **{k: rep[k] for k in ("identity_drift", "head_drift", "boil", "flicker", "sharpness", "coverage_jitter")}}


def judge_loops(run, kind):
    meta = json.load(open(f"{run}/sheet.json"))
    res = {}
    for d in DIRS:
        lp = meta["loops"][d]
        frames, res[d] = judge_loop(sorted(glob.glob(f"{run}/raw/walk-{d}/*.png")), lp["start"], lp["period"])
        res[d]["loop"] = lp
        o = os.path.join(out_dir(kind), "judge", d)
        os.makedirs(o, exist_ok=True)
        _judge()._sheet(frames, os.path.join(o, "sheet.png"))
        _judge()._sheet(frames, os.path.join(o, "heads.png"), head=True)
    return res


def off_palette(paths):
    """Share of the opaque pixels in these frames whose colour is not one of the pack's locked 34."""
    import palette
    pal = np.array([r << 16 | g << 8 | b for r, g, b in palette.RGB])
    px = np.concatenate([a[a[..., 3] > 128][:, :3].astype(np.int64)
                         for a in (np.asarray(Image.open(p).convert("RGBA")) for p in paths)])
    return round(float(1 - np.isin(px[:, 0] << 16 | px[:, 1] << 8 | px[:, 2], pal).mean()), 4)


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
    """Every ship gate, thresholds from cast-gate-spec.json. Exit 0 only if every one passes."""
    run, kind = os.path.abspath(a.run), a.kind
    out, ok = {"kind": kind, "run": run, "spec": SPEC}, {}

    def say(name, passed, detail):
        ok[name] = passed
        print(f"{'PASS' if passed else 'FAIL'}  {name:22s} {detail}", flush=True)

    loops = json.load(open(f"{run}/sheet.json"))["loops"]
    out["seam"] = {d: loops[d]["seam"] for d in DIRS}
    lim = {d: SPEC.get("seam_max_dir", {}).get(d, SPEC["seam_max"]) for d in DIRS}
    bad = {d: v for d, v in out["seam"].items() if v > lim[d]}
    say("1 loop seam", not bad, " ".join(f"{d} {v}/{lim[d]}" for d, v in out["seam"].items()))

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
    say("5 judge + boil", all(r["pass"] for r in out["judge"].values()),
        " ".join(f"{d} {'ok' if r['pass'] else 'FAIL:' + ','.join(k for k, v in r['gates'].items() if not v)}"
                 for d, r in out["judge"].items()))

    senv = {**env, "VERIFY_THEME": SPEC["style"]["theme"], "STYLE_ANCHORS": ",".join(SPEC["style"]["anchors"])}
    rc, txt = _tail([sys.executable, "verify.py", "--style", "--kind", kind], senv)
    out["style"] = txt.splitlines()[-12:]
    say("6 style vs frog", rc == 0, txt.splitlines()[-1])

    theme = os.path.join(THEMES, SPEC["style"]["theme"], "chars")
    out["palette"] = {d: off_palette([os.path.join(theme, f"{kind}-{d}-{p}.png") for p in POSES]) for d in DIRS}
    say("6b locked palette", all(v <= SPEC["palette"]["off_max"] for v in out["palette"].values()),
        f"off-palette share, max {SPEC['palette']['off_max']}: " + " ".join(f"{d} {v}" for d, v in out["palette"].items()))

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
            p.add_argument("--take", nargs="+", action="extend",  # repeated --take flags add up, not last-wins
                           help="dir=<other run>, e.g. n=runs/x/take2-n/video-s11")
            p.add_argument("--out", required=True)
            p.add_argument("--period", default="12:64")
        if name == "export":
            p.add_argument("--arch", nargs="+", help="archetypes to key (default: those already using the kind)")
        if name == "sheet":
            p.add_argument("--ref", default="frog-settler")
    sub.add_parser("strip").add_argument("--kind", nargs="+", required=True)
    a = ap.parse_args()
    {"assemble": cmd_assemble, "export": cmd_export, "sheet": cmd_sheet, "gate": cmd_gate, "strip": cmd_strip}[a.cmd](a)


if __name__ == "__main__":
    main()
