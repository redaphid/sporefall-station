#!/usr/bin/env bash
# Render the 5-direction x 8-frame walk-cycle motion source on the `soul` box
# (Windows Blender 5.x called headless from WSL; see docs/sprite-generation.md).
#
#   bash render.sh [dest-dir]      # frames land in dest-dir (default: $STAGE)
#
# Env: RES=1024 render resolution; BLENDER=/mnt/d/tools/blender/blender.exe
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-${SWAMPSPACE_STAGE:-/tmp/swampspace-stage}/rotoscope/blender}"
RES="${RES:-1024}"
BLENDER="${BLENDER:-/mnt/d/tools/blender/blender.exe}"
REMOTE=/mnt/d/tmp/backseat-roto   # D: drive — readable by the Windows binary as D:/

# ssh prints benign "Could not request local forwarding" noise (tunnel aliases
# already hold the ports); stderr is left visible on purpose, ignore those lines.
# remote shell is zsh: unmatched globs abort, so clean with find
ssh soul "mkdir -p $REMOTE/frames && find $REMOTE/frames -name 'walk-*.png' -delete"
scp "$HERE/rig_walk.py" soul:$REMOTE/
ssh soul "$BLENDER -b -P 'D:/tmp/backseat-roto/rig_walk.py' -- --out 'D:/tmp/backseat-roto/frames' --res $RES" \
  | grep -E "rendered|RIG_WALK_DONE|Error" || { echo "blender run failed"; exit 1; }
mkdir -p "$DEST"
scp -q "soul:$REMOTE/frames/walk-*.png" "$DEST/"
ls "$DEST" | wc -l
echo "frames -> $DEST"
