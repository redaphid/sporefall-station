#!/usr/bin/env python3
"""VLM gate for the swampspace pack (Ollama qwen3-vl on localhost:11434).

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
Exit code = number of failures (CI-gate style). Majority vote over 3 reads.
"""
import base64
import io
import json
import os
import sys
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
MODEL = os.environ.get("VLM", "qwen3-vl:8b")
VOTES = int(os.environ.get("VOTES", "3"))

PROMPT = (
    "You are a QA inspector for 2D game sprites. Look at the image and answer ONLY with "
    'JSON: {"subject": "<one short noun>", '
    '"is_figure": <true if the main subject is a person/humanoid/creature/animal/robot-with-body, else false>, '
    '"camera": "<one of: top-down, upright, side, scene>", '
    '"facing": "<one of: toward-viewer, away, left, right, na — which way a character faces; na if not a character>", '
    '"face_visible": <true if a face or eyes are visible, else false>}'
)


def ask(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (128, 128, 128, 255))
        bg.alpha_composite(im)
        im = bg.convert("RGB")
    else:
        im = im.convert("RGB")
    if max(im.size) < 256:  # tiny sprites: nearest-upscale so the VLM can see pixels
        f = 256 // max(im.size) + 1
        im = im.resize((im.width * f, im.height * f), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    body = {"model": MODEL, "prompt": PROMPT,
            "images": [base64.b64encode(buf.getvalue()).decode()],
            "stream": False, "think": False, "options": {"temperature": 0}}
    raw = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(OLLAMA + "/api/generate", json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
            raw = json.load(urllib.request.urlopen(req, timeout=180)).get("response", "").strip()
            break
        except Exception:
            import time
            time.sleep(3 * (attempt + 1))
    a, b = raw.find("{"), raw.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(raw[a:b + 1])
        except Exception:
            pass
    return {"subject": "?", "is_figure": None, "camera": "?", "facing": "?",
            "face_visible": None, "_raw": raw[:160]}


def check(path, spec):
    """Majority-vote verdict for one image against its job spec. Returns problems []."""
    votes = [ask(path) for _ in range(VOTES)]
    maj = VOTES // 2 + 1
    probs = []

    def count(key, *vals):
        return sum(1 for v in votes if v.get(key) in vals)

    cat = spec["cat"]
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
        if d == "e" and count("facing", "toward-viewer", "away") >= maj:
            probs.append("'e' sprite does not read as a profile")
        if count("is_figure", False) >= maj and spec["kind"] not in ("spore-drone", "derelict-bot"):
            probs.append("character does not read as a figure")
    return votes[-1], probs


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
    body = {"model": MODEL, "prompt": PAIR_PROMPT,
            "images": [_b64(idle_path), _b64(step_path)],
            "stream": False, "think": False, "options": {"temperature": 0}}
    raw = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(OLLAMA + "/api/generate", json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
            raw = json.load(urllib.request.urlopen(req, timeout=300)).get("response", "").strip()
            break
        except Exception:
            import time
            time.sleep(3 * (attempt + 1))
    a, b = raw.find("{"), raw.rfind("}")
    v = {}
    if a != -1 and b > a:
        try:
            v = json.loads(raw[a:b + 1])
        except Exception:
            pass
    probs = [k for k in ("same_character", "same_posture", "same_gear", "only_limbs_differ")
             if v.get(k) is False]
    return v, probs


def pairs_mode():
    """Verify every curated idle/step pair in the theme dir."""
    J = G.jobs()
    fails = 0
    checked = 0
    for name, spec in J.items():
        if spec["cat"] != "char" or spec["frame"] != "step":
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
    "Judge identity, not pose: same body proportions (height, bulk, head size), same "
    "outfit and colors, same gear. Answer ONLY with JSON: "
    '{"same_character": <bool>, "same_proportions": <bool>, "same_outfit": <bool>, '
    '"reason": "<short>"}'
)


def check_same(path_a, path_b):
    """VLM gate: are these two sprites the same character in different poses?
    Majority vote over VOTES reads. Returns (verdict, problems)."""
    imgs = [_b64(path_a), _b64(path_b)]
    votes = []
    for _ in range(VOTES):
        body = {"model": MODEL, "prompt": SAME_PROMPT, "images": imgs,
                "stream": False, "think": False, "options": {"temperature": 0}}
        raw = ""
        for attempt in range(4):
            try:
                req = urllib.request.Request(OLLAMA + "/api/generate",
                                             json.dumps(body).encode(),
                                             {"Content-Type": "application/json"})
                raw = json.load(urllib.request.urlopen(req, timeout=300)).get("response", "").strip()
                break
            except Exception:
                import time
                time.sleep(3 * (attempt + 1))
        a, b = raw.find("{"), raw.rfind("}")
        v = {}
        if a != -1 and b > a:
            try:
                v = json.loads(raw[a:b + 1])
            except Exception:
                pass
        votes.append(v)
    maj = VOTES // 2 + 1
    probs = [k for k in ("same_character", "same_proportions", "same_outfit")
             if sum(1 for v in votes if v.get(k) is False) >= maj]
    return votes[-1], probs


def same_mode():
    """--same: every curated direction frame of each character vs its s-idle.
    (Cross-DIRECTION identity — --pairs covers idle/step within a direction.)"""
    J = G.jobs()
    fails = 0
    checked = 0
    for name, spec in J.items():
        if spec["cat"] != "char" or (spec["dir"] == "s" and spec["frame"] == "idle"):
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
    "pixel-art game. Judge whether the candidate belongs to the same game: same "
    "pixel-art style and pixel density, same overall color palette (dark teal/olive "
    "with green/amber accents), same flat lighting. Answer ONLY with JSON: "
    '{"same_style": <bool>, "same_palette": <bool>, "reason": "<short>"}'
)

# pack-wide style anchors: the player front sprite, the hero prop, the floor
STYLE_ANCHORS = ("chars/vine-ranger-s-idle.png", "props/spore-barrel.png")


def style_mode():
    """Compare every curated sprite against the pack's style anchors."""
    anchors = [os.path.join(G.THEME, a) for a in STYLE_ANCHORS]
    anchors = [a for a in anchors if os.path.exists(a)]
    fails = 0
    checked = 0
    J = G.jobs()
    for name, spec in J.items():
        p = os.path.join(G.THEME, spec["path"])
        if not os.path.exists(p) or spec["path"] in STYLE_ANCHORS:
            continue
        body = {"model": MODEL, "prompt": STYLE_PROMPT,
                "images": [_b64(p)] + [_b64(a) for a in anchors],
                "stream": False, "think": False, "options": {"temperature": 0}}
        raw = ""
        for attempt in range(4):
            try:
                req = urllib.request.Request(OLLAMA + "/api/generate",
                                             json.dumps(body).encode(),
                                             {"Content-Type": "application/json"})
                raw = json.load(urllib.request.urlopen(req, timeout=300)).get("response", "").strip()
                break
            except Exception:
                import time
                time.sleep(3 * (attempt + 1))
        a, b = raw.find("{"), raw.rfind("}")
        v = {}
        if a != -1 and b > a:
            try:
                v = json.loads(raw[a:b + 1])
            except Exception:
                pass
        probs = [k for k in ("same_style", "same_palette") if v.get(k) is False]
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    J = G.jobs()
    targets = []  # (path, spec)
    if "--pack" in sys.argv:
        for name, spec in J.items():
            p = os.path.join(G.THEME, spec["path"])
            if os.path.exists(p):
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
              f"facing={v.get('facing','?'):13s} {'; '.join(probs)}")
    print(f"\n{fails} FAIL / {len(targets)} checked")
    sys.exit(min(fails, 120))


if __name__ == "__main__":
    main()
