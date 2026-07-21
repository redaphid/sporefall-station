#!/usr/bin/env python3
"""One-time migration: make curation.json's raws DURABLE.

The original pack recorded each curated pick's raw by its ephemeral $STAGE
(/tmp) path. Those paths died with the session; a same-seed regen no longer
reproduces the approved pick because the ComfyUI graph/prompts drift over time
(this is the documented /tmp-loss gotcha). This script:

  1. For every curation.json entry, tries `generate.resolve_raw` to locate a
     surviving source (a still-present recorded path, an already-durable
     raws/<job>.png, or — for character s-idles — the curated anchor).
  2. Copies any survivor into the committed `raws/<job>.png` and rewrites the
     entry's `raw` to the portable relative path.
  3. Reports the split: PERSISTED (now durable), ALREADY (already durable), and
     LOST (no recoverable source — these must be RE-CURATED via a fresh sweep).

Idempotent. Run:  python3 migrate_curation.py [--write]
Without --write it's a dry run (reports only, touches nothing).
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G

WRITE = "--write" in sys.argv


def main():
    cur = json.load(open(G.CURATION))
    os.makedirs(G.RAWS, exist_ok=True)
    persisted, already, lost = [], [], []
    for name in sorted(cur):
        pick = cur[name]
        durable = os.path.join(G.RAWS, name + ".png")
        rawrel = pick.get("raw", "")
        if rawrel == os.path.relpath(durable, HERE) and os.path.exists(durable):
            already.append(name)
            continue
        src = G.resolve_raw(name, pick)
        if not src:
            lost.append(name)
            continue
        if WRITE:
            shutil.copyfile(src, durable)
            pick["raw"] = os.path.relpath(durable, HERE)
        persisted.append((name, os.path.relpath(src, G.REPO)))

    if WRITE:
        json.dump(cur, open(G.CURATION, "w"), indent=1)

    print(f"=== PERSISTED ({len(persisted)}) — copied to raws/, now reproducible ===")
    for n, s in persisted:
        print(f"  {n:34s} <- {s}")
    print(f"\n=== ALREADY DURABLE ({len(already)}) ===")
    for n in already:
        print(f"  {n}")
    print(f"\n=== LOST ({len(lost)}) — raw gone, MUST re-curate (sweep + curate) ===")
    for n in lost:
        print(f"  {n}")
    print(f"\n{'WROTE' if WRITE else 'DRY-RUN (pass --write to apply)'}: "
          f"{len(persisted)} persisted, {len(already)} already, {len(lost)} lost")


if __name__ == "__main__":
    main()
