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


def main():
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
