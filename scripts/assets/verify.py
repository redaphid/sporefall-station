#!/usr/bin/env python3
"""VLM gate for the swampspace pack (Ollama qwen3-vl-instruct; OLLAMA picks the server).

Checks each candidate/curated asset against its job spec:
  * props/items/tiles must NOT read as a person/creature (the
    anthropomorphized-lamp-post failure mode from the prior pack);
  * tiles must read top-down (floor) — walls are exempt (straight-on is fine);
  * characters must face the right way per direction:
      s/se -> face visible;  n/ne -> back view, face NOT visible;  e -> profile.

Usage:
  python3 verify.py <file-or-dir>... [--job <jobname>]   # ad-hoc file check
  python3 verify.py --pack                               # verify curated pack
  python3 verify.py --pairs                              # idle/step consistency
  python3 verify.py --same [a.png b.png]                 # cross-direction identity
                                                         # (pack-wide vs each s-idle)
Exit code = number of failures (CI-gate style). Majority vote over VOTES reads (default 1).
"""
import base64
import io
import json
import os
import sys
import time
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G

# VERIFY_THEME=swampspace-hires gates the pack the game loads (default: the 48 px base pack)
if os.environ.get("VERIFY_THEME"):
    G.THEME = os.path.join(os.path.dirname(G.THEME), os.environ["VERIFY_THEME"])

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
# --kind <kind>: only that character's jobs in --pack / --pairs / --same
KIND = sys.argv[sys.argv.index("--kind") + 1] if "--kind" in sys.argv else None


def _wanted(spec):
    return KIND is None or spec.get("kind") == KIND
# The instruct tag answers in ~45 tokens. The plain qwen3-vl:8b tag is the thinking variant: it
# ignores "think": false and thinks 140-1500 tokens first, 10-20 s a call, which made a cast gate
# take an hour. At temperature 0 the instruct tag gives the same answer every time, so extra votes
# repeat one read; VOTES > 1 is for a sampling model.
MODEL = os.environ.get("VLM", "qwen3-vl:8b-instruct")
VOTES = int(os.environ.get("VOTES", "1"))

PROMPT = (
    "You are a QA inspector for 2D game sprites. Look at the image and answer ONLY with "
    'JSON: {"subject": "<one short noun>", '
    '"is_figure": <true if the main subject is a person/humanoid/creature/animal/robot-with-body, else false>, '
    '"camera": "<one of: top-down, upright, side, scene>", '
    '"facing": "<one of: toward-viewer, away, left, right, na — which way a character faces; na if not a character>", '
    '"face_visible": <true if a face or eyes are visible, else false>}'
)


# A thinking model needs ~1500 tokens before its answer (VLM=qwen3-vl:8b NUM_PREDICT=4096); the
# instruct default answers in ~45, so the cap only bounds a reply that rambles.
NUM_PREDICT = int(os.environ.get("NUM_PREDICT", "512"))


def _generate(prompt, images):
    """One VLM call. Returns the JSON object it answered, or {"_raw": <why there is none>}."""
    body = {"model": MODEL, "prompt": prompt, "images": images, "stream": False, "think": False,
            "options": {"temperature": 0, "num_predict": NUM_PREDICT}}
    r = {}
    for attempt in range(4):
        try:
            req = urllib.request.Request(OLLAMA + "/api/generate", json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=300))
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    raw = r.get("response", "").strip()
    a, b = raw.find("{"), raw.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(raw[a:b + 1])
        except Exception:
            pass
    if r.get("done_reason") == "length":
        return {"_raw": f"out of tokens ({r.get('eval_count')} of num_predict {NUM_PREDICT})"}
    return {"_raw": raw[:160] if r else f"no reply from {OLLAMA} ({MODEL})"}


def ask(path):
    v = _generate(PROMPT, [_b64(path)])
    if "_raw" in v:
        return {"subject": "?", "is_figure": None, "camera": "?", "facing": "?", "face_visible": None, **v}
    return v


VIEW_PROMPT = (
    "The three images show ONE game character. Image 1 shows it from the FRONT. Image 2 shows it "
    "from the BACK. Judge image 3: is the character seen from the front (like image 1), from the "
    "back (like image 2), or from the side (a profile: the body turned 90 degrees, walking left or "
    'right across the picture)? Answer ONLY with JSON: {"view": "<front, back or side>"}'
)
# The view each direction may read as, judged against the character's own s-idle (front) and
# n-idle (back). One-image "which way does it face" has nothing to go on for a sealed visor or a
# hood: it read 6 of the mycologist's 10 east profiles as "away" (and the frog's as "right").
VIEWS_OK = {"s": {"front", "side"}, "se": {"front", "side"}, "e": {"side"},
            "ne": {"back", "side"}, "n": {"back", "side"}}


def view_votes(path, kind):
    refs = [os.path.join(G.THEME, f"chars/{kind}-{d}-idle.png") for d in ("s", "n")]
    if not all(os.path.exists(r) for r in refs):
        return None
    imgs = [_b64(r) for r in refs] + [_b64(path)]
    return [_generate(VIEW_PROMPT, imgs).get("view") for _ in range(VOTES)]


def check(path, spec):
    """Majority-vote verdict for one image against its job spec. Returns problems []."""
    votes = [ask(path) for _ in range(VOTES)]
    maj = VOTES // 2 + 1
    probs = []

    def count(key, *vals):
        return sum(1 for v in votes if v.get(key) in vals)

    if all("_raw" in v for v in votes):  # no vote parsed, and every rule would pass
        return {}, [f"no VLM answer: {votes[-1]['_raw']}"]
    cat = spec["cat"]
    views = None
    if cat in ("prop", "item", "tile", "fx"):
        if count("is_figure", True) >= maj:
            probs.append(f"reads as a FIGURE (subject={votes[-1].get('subject')!r})")
    if cat == "tile" and "floor" not in spec["path"] and "deck" not in spec["path"]:
        pass  # wall tiles: any straight-on camera is fine
    elif cat == "tile":
        if count("camera", "side", "scene") >= maj:
            probs.append("floor tile does not read top-down")
    if cat == "char":
        d = spec["dir"]
        if d in ("n", "ne") and count("face_visible", True) >= maj:
            probs.append(f"'{d}' sprite shows a face — should be a back view")
        if d == "s" and count("facing", "away") >= maj:
            probs.append("'s' sprite reads as facing away")
        views = view_votes(path, spec["kind"])
        if views is None:
            probs.append(f"no s-idle/n-idle of {spec['kind']} to judge the view against")
        elif sum(1 for v in views if v in VIEWS_OK[d]) < maj:
            probs.append(f"'{d}' sprite reads as a {views[-1]} view")
        if count("is_figure", False) >= maj and spec["kind"] not in ("spore-drone", "derelict-bot"):
            probs.append("character does not read as a figure")
    return {**votes[-1], "view": (views or ["-"])[-1]}, probs


PAIR_PROMPT = (
    "These two images are the IDLE and STEP frames of one game character's walk "
    "cycle. They must show the SAME character with the SAME posture, proportions, "
    "outfit and gear — differing ONLY in leg/arm phase (mid-stride). Answer ONLY "
    'with JSON: {"same_character": <bool>, "same_posture": <bool — false if one '
    'slouches/leans/sits while the other stands upright>, "same_gear": <bool>, '
    '"only_limbs_differ": <bool>}'
)


def _b64(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (128, 128, 128, 255))
        bg.alpha_composite(im)
        im = bg.convert("RGB")
    if max(im.size) < 256:
        f = 256 // max(im.size) + 1
        im = im.resize((im.width * f, im.height * f), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def check_pair(idle_path, step_path):
    """VLM gate for idle/step pose consistency. Returns (verdict, problems)."""
    v = _generate(PAIR_PROMPT, [_b64(idle_path), _b64(step_path)])
    probs = [k for k in ("same_character", "same_posture", "same_gear", "only_limbs_differ")
             if v.get(k) is False]
    if "_raw" in v:
        probs = [f"no VLM answer: {v['_raw']}"]
    return v, probs


def pairs_mode():
    """Verify every curated idle/step pair in the theme dir."""
    J = G.jobs()
    fails = 0
    checked = 0
    for name, spec in J.items():
        if spec["cat"] != "char" or spec["frame"] != "step" or not _wanted(spec):
            continue
        step = os.path.join(G.THEME, spec["path"])
        idle = os.path.join(G.THEME, spec["path"].replace("-step", "-idle"))
        if not (os.path.exists(step) and os.path.exists(idle)):
            continue
        if os.path.realpath(step) == os.path.realpath(idle):
            continue
        v, probs = check_pair(idle, step)
        checked += 1
        mark = "ok  " if not probs else "FAIL"
        fails += 0 if not probs else 1
        print(f"{mark} {os.path.basename(step):34s} {v} {probs}")
    print(f"\n{fails} FAIL / {checked} pairs")
    sys.exit(min(fails, 120))


SAME_PROMPT = (
    "These two images show sprites from one pixel-art game, supposedly the SAME "
    "character viewed from two different directions (front/side/back/three-quarter). "
    "A back or three-quarter-back view cannot show what is on the front (a face, a visor, "
    "a chest badge), and can show what is on the back (a tank, a pack): never count those as differences. "
    "Judge identity from what both views share: same body proportions (height, bulk, head size), "
    "same outfit colours and materials, same gear. Answer ONLY with JSON: "
    '{"same_character": <bool>, "same_proportions": <bool>, "same_outfit": <bool>, '
    '"reason": "<short>"}'
)
# The old prompt ("same outfit and colors") failed every back view of the blast-diver, whose front
# is a saturated orange visor its back cannot show ("first image has a large orange visor"), while
# a back from another character still fails for bulk and suit colour: cast_gate_selftest.py.


def check_same(path_a, path_b):
    """VLM gate: are these two sprites the same character in different poses?
    Majority vote over VOTES reads. Returns (verdict, problems)."""
    imgs = [_b64(path_a), _b64(path_b)]
    votes = [_generate(SAME_PROMPT, imgs) for _ in range(VOTES)]
    maj = VOTES // 2 + 1
    probs = [k for k in ("same_character", "same_proportions", "same_outfit")
             if sum(1 for v in votes if v.get(k) is False) >= maj]
    if all("_raw" in v for v in votes):
        probs = [f"no VLM answer: {votes[-1]['_raw']}"]
    return votes[-1], probs


def same_mode():
    """--same: every curated direction frame of each character vs its s-idle.
    (Cross-DIRECTION identity — --pairs covers idle/step within a direction.)"""
    J = G.jobs()
    fails = 0
    checked = 0
    for name, spec in J.items():
        if spec["cat"] != "char" or (spec["dir"] == "s" and spec["frame"] == "idle") or not _wanted(spec):
            continue
        p = os.path.join(G.THEME, spec["path"])
        anchor = os.path.join(G.THEME, f"chars/{spec['kind']}-s-idle.png")
        if not (os.path.exists(p) and os.path.exists(anchor)):
            continue
        if os.path.realpath(p) == os.path.realpath(anchor):
            continue
        v, probs = check_same(anchor, p)
        checked += 1
        fails += 1 if probs else 0
        mark = "ok  " if not probs else "FAIL"
        print(f"{mark} {os.path.basename(p):34s} {probs} {v.get('reason', '')[:70]}", flush=True)
    print(f"\n{fails} FAIL / {checked} identity-checked")
    sys.exit(min(fails, 120))


STYLE_PROMPT = (
    "Image 1 is a candidate sprite; images 2 and 3 are style anchors from the same "
    "pixel-art game. Judge whether the candidate is drawn the same way: same pixel-art "
    "style and pixel density, same outline weight, same flat lighting. Judge the rendering "
    "only, not the design or its colours: each character has its own colour scheme. "
    'Answer ONLY with JSON: {"same_style": <bool>, "reason": "<short>"}'
)
# Colour is not asked: an earlier prompt described the palette as "dark teal/olive with
# green/amber accents" and failed the cream hazmat mycologist, whose every pixel is one of the
# pack's locked 34 colours. cast_walk.py gate measures palette membership exactly.

# pack-wide style anchors: the player front sprite, the hero prop, the floor
STYLE_ANCHORS = tuple(os.environ.get("STYLE_ANCHORS", "chars/vine-ranger-s-idle.png,props/spore-barrel.png")
                      .split(","))  # STYLE_ANCHORS=chars/frog-settler-s-idle.png,... to judge against other refs


def check_style(path, anchors):
    v = _generate(STYLE_PROMPT, [_b64(path)] + [_b64(a) for a in anchors])
    if "_raw" in v:
        return v, [f"no VLM answer: {v['_raw']}"]
    return v, ["same_style"] if v.get("same_style") is False else []


def style_mode():
    """Compare every curated sprite against the pack's style anchors."""
    anchors = [os.path.join(G.THEME, a) for a in STYLE_ANCHORS]
    anchors = [a for a in anchors if os.path.exists(a)]
    fails = 0
    checked = 0
    J = G.jobs()
    for name, spec in J.items():
        p = os.path.join(G.THEME, spec["path"])
        if not os.path.exists(p) or spec["path"] in STYLE_ANCHORS or not _wanted(spec):
            continue
        v, probs = check_style(p, anchors)
        checked += 1
        fails += 1 if probs else 0
        mark = "ok  " if not probs else "FAIL"
        print(f"{mark} {spec['path']:44s} {probs} {v.get('reason','')[:60]}", flush=True)
    print(f"\n{fails} FAIL / {checked} style-checked")
    sys.exit(min(fails, 120))


def main():
    if "--pairs" in sys.argv:
        pairs_mode()
        return
    if "--style" in sys.argv:
        style_mode()
        return
    if "--same" in sys.argv:
        rest = [a for a in sys.argv[1:] if not a.startswith("--")]
        if len(rest) == 2:  # ad-hoc: verify.py --same a.png b.png
            v, probs = check_same(rest[0], rest[1])
            print(("ok  " if not probs else "FAIL"), probs, v)
            sys.exit(1 if probs else 0)
        same_mode()
        return
    args = [a for i, a in enumerate(sys.argv[1:], 1)
            if not a.startswith("--") and sys.argv[i - 1] not in ("--kind", "--job")]
    J = G.jobs()
    targets = []  # (path, spec)
    if "--pack" in sys.argv:
        for name, spec in J.items():
            p = os.path.join(G.THEME, spec["path"])
            if os.path.exists(p) and _wanted(spec):
                targets.append((name, p, spec))
    else:
        jobname = None
        for i, a in enumerate(sys.argv):
            if a == "--job":
                jobname = sys.argv[i + 1]
        for a in args:
            files = ([os.path.join(a, f) for f in sorted(os.listdir(a))]
                     if os.path.isdir(a) else [a])
            for f in files:
                if not f.endswith(".png"):
                    continue
                name = jobname or os.path.basename(os.path.dirname(f))
                spec = J.get(name)
                if spec is None:
                    print(f"?? {f}: no job spec (pass --job)", file=sys.stderr)
                    continue
                targets.append((name, f, spec))
    fails = 0
    for name, path, spec in targets:
        v, probs = check(path, spec)
        ok = not probs
        fails += 0 if ok else 1
        mark = "ok " if ok else "FAIL"
        print(f"{mark} {os.path.basename(path):34s} subj={v.get('subject','?')!r:20s} "
              f"facing={v.get('facing','?'):13s} view={v.get('view','-')!s:5s} {'; '.join(probs)}")
    print(f"\n{fails} FAIL / {len(targets)} checked")
    sys.exit(min(fails, 120))


if __name__ == "__main__":
    main()
