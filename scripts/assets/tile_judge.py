#!/usr/bin/env python3
"""Aesthetic judge for Genesis-grade tiles (Ollama qwen3-vl, localhost:11434).

Where verify.py gates SEMANTICS (is this a figure? does it read top-down?),
this scores LOOK: is it clean chunky 16-bit pixel art, or noisy confetti?
Returns a 0-10 score + short critique per tile, plus a machine "confetti"
metric (high-frequency energy) so the iteration loop can pick candidates and
tune params without a human in the loop overnight.

Usage:
  python3 tile_judge.py <file>...              # score each file
  python3 tile_judge.py --pick <file>...       # print the best file path
  python3 tile_judge.py --surface floor <f>... # judge against a surface brief
"""
import base64
import io
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
MODEL = os.environ.get("VLM", "qwen3-vl:8b")
VOTES = int(os.environ.get("JUDGE_VOTES", "2"))

# What "good" means per surface — fed to the VLM so it judges against intent.
BRIEF = {
    "floor": "a warm tan sci-fi metal deck floor: clean rectangular plates, "
             "dark seam lines, a few rivets, small moss tufts in the seams",
    "street": "dark cracked asphalt: near-black tarmac, faint gray wear, thin "
              "moss in the cracks",
    "grass": "swamp moss ground: chunky clumps of green bog grass tufts, dark "
             "peat hollows, a few glowing spore dots",
    "sidewalk": "light gray riveted metal walkway plates with dark joints",
    "wall": "a dark root-woven bulkhead wall with a lit steel cap strip on top",
    "exit": "a bright glowing green bioluminescent launch pad",
}

PROMPT_TMPL = (
    "You are an expert pixel-art director reviewing a seamless top-down GAME "
    "TILE meant to look like Sega Genesis / SNES 16-bit art. It should be {brief}. "
    "Judge ONLY the craft. GOOD = clean readable shapes, deliberate chunky "
    "pixel clusters, clear structure, purposeful dither. BAD = random noisy "
    "confetti / salt-and-pepper speckle, muddy mush, blurry smearing, lost "
    "structure, or wrong subject. Answer ONLY with JSON: "
    '{{"score": <0-10 integer>, "confetti": <true if noisy random speckle '
    'dominates>, "structure_clear": <bool>, "critique": "<one short phrase>"}}'
)


def _b64(im):
    if max(im.size) < 256:
        f = 256 // max(im.size) + 1
        im = im.resize((im.width * f, im.height * f), Image.NEAREST)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def confetti_metric(im):
    """Fraction of pixels whose value differs from ALL 4 neighbors — an
    isolated-pixel (salt-and-pepper) ratio. High = confetti."""
    a = np.asarray(im.convert("L"), np.int16)
    d = 6  # value tolerance for "same as neighbor"
    same = np.zeros(a.shape, np.int8)
    same[1:] += (np.abs(a[1:] - a[:-1]) <= d)[1:] if False else 0  # placeholder
    up = np.abs(a[1:] - a[:-1]) <= d
    down = np.abs(a[:-1] - a[1:]) <= d
    left = np.abs(a[:, 1:] - a[:, :-1]) <= d
    right = np.abs(a[:, :-1] - a[:, 1:]) <= d
    iso = np.ones(a.shape, bool)
    iso[1:] &= ~up
    iso[:-1] &= ~down
    iso[:, 1:] &= ~left
    iso[:, :-1] &= ~right
    return float(iso.mean())


def ask(im, surface):
    brief = BRIEF.get(surface, "a clean seamless game tile")
    body = {"model": MODEL, "prompt": PROMPT_TMPL.format(brief=brief),
            "images": [_b64(im)], "stream": False, "think": False,
            "options": {"temperature": 0}}
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
    return {"score": 0, "confetti": True, "structure_clear": False, "critique": raw[:80]}


def judge(path, surface):
    im = Image.open(path)
    # tile files are one tile; judge a 2x2 wrap-repeat so seams + repeat show
    tiled = Image.new("RGB", (im.width * 2, im.height * 2))
    for j in range(2):
        for i in range(2):
            tiled.paste(im.convert("RGB"), (i * im.width, j * im.height))
    votes = [ask(tiled, surface) for _ in range(VOTES)]
    score = float(np.median([v.get("score", 0) or 0 for v in votes]))
    confetti_votes = sum(1 for v in votes if v.get("confetti"))
    conf_px = confetti_metric(im)
    return {
        "path": path, "surface": surface, "score": score,
        "vlm_confetti": confetti_votes >= (VOTES + 1) // 2,
        "confetti_px": round(conf_px, 3),
        "structure": all(v.get("structure_clear") for v in votes),
        "critique": votes[-1].get("critique", ""),
    }


def surface_of(path):
    b = os.path.basename(path)
    for s in BRIEF:
        if b.startswith(s):
            return s
    return "floor"


def main():
    args = sys.argv[1:]
    pick = "--pick" in args
    surface = None
    if "--surface" in args:
        i = args.index("--surface")
        surface = args[i + 1]
        args = args[:i] + args[i + 2:]
    files = [a for a in args if not a.startswith("--")]
    results = [judge(f, surface or surface_of(f)) for f in files]
    if pick:
        best = max(results, key=lambda r: (r["score"] - (3 if r["vlm_confetti"] else 0)
                                           - r["confetti_px"] * 20))
        print(best["path"])
        return
    for r in results:
        print(f"{os.path.basename(r['path']):28s} score={r['score']:4.1f} "
              f"confetti(vlm={r['vlm_confetti']},px={r['confetti_px']:.3f}) "
              f"struct={r['structure']}  {r['critique']}")


if __name__ == "__main__":
    main()
