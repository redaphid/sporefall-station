#!/usr/bin/env bash
# One-command rotoscoped walk cycle for a character (default: the vine-ranger).
#
#   CHAR=vine-ranger bash run.sh
#
# Stages (see docs/sprite-generation.md "Rotoscoped animation"):
#   1. render.sh  — Blender on `soul` renders the procedural walk proxy
#                   (5 dirs x 8 frames, transparent, fixed ortho framing)
#   2. trace.py   — ComfyUI img2img re-develops each frame into pack style
#                   (low denoise + IPAdapter anchor), Blender-alpha mask,
#                   fixed-window k-centroid + palette -> 48px theme frames
#   3. gate.py    — deterministic + coherence + VLM gates (exit != 0 stops)
#   4. manifest   — re-emit manifest.json with the char.<arch>.<dir>-walk-<n>
#                   clips + anim cadence
#
# For a NEW character: give the Blender proxy its color blocking in
# rig_walk.py, make sure anchors/<char>-s-idle.png exists, then run this.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export CHAR="${CHAR:-vine-ranger}"
export SWAMPSPACE_STAGE="${SWAMPSPACE_STAGE:-/tmp/swampspace-stage}"

bash "$HERE/render.sh"
python3 "$HERE/trace.py"
python3 "$HERE/gate.py"
python3 "$HERE/../manifest.py"
echo "[rotoscope] $CHAR walk cycles shipped + gated + manifested"
