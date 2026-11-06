#!/usr/bin/env python3
"""Keyframe-only probe: the Qwen-Image-Edit band of spritesheet.video_graph for one direction, N seeds.
A Step 0 still batch: per RUNBOOK Locks it may run while another batch holds gpu-run's lock. Feeds rig_quadruped/rig_biped + fun_control.
  python3 keyframe_probe.py <input.png> <dir> <describe.txt> <pose> <out> <seed>...
Writes <out>/<dir>-kf-s<seed>.png (1280x720) and the pruned graph flow-kf-s<seed>_api.json."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import spritesheet as S

src, d, desc, pose, out, *seeds = sys.argv[1:]
os.makedirs(out, exist_ok=True)
q, notes = S.detect_qwen({})
w, _ = S.detect_wan({})
name = S.upload(S.prep_input(src), "pipeline1105-kf-input.png")
S.MOTIONS["probe"] = S.Motion(pose, "", closed=False)
pids = {}
for seed in map(int, seeds):
    g = S.video_graph(name, d, seed, q, w, open(desc).read().strip(), S.STYLE, f"sprite-sheet/pipeline1105/kf-s{seed}", "probe")
    save = next(k for k, n in g.nodes.items() if n["class_type"] == "SaveImage" and "keyframe" in n["inputs"]["filename_prefix"])
    keep, todo = set(), [save]
    while todo:  # every node the keyframe SaveImage depends on, and nothing of the Wan band
        k = todo.pop()
        if k in keep: continue
        keep.add(k)
        todo += [v[0] for v in g.nodes[k]["inputs"].values() if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)]
    api = {k: v for k, v in g.nodes.items() if k in keep}
    json.dump(api, open(f"{out}/flow-kf-s{seed}_api.json", "w"), indent=1)
    pids[seed] = S.queue(api)
for seed, pid in pids.items():
    outs = S.wait(pid, limit_s=900)
    ims = [im for imgs in outs.values() for im in imgs]
    S.fetch(ims[0]).save(f"{out}/{d}-kf-s{seed}.png")
    print(f"seed {seed} -> {out}/{d}-kf-s{seed}.png", flush=True)
