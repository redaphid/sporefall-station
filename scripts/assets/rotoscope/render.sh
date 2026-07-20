#!/usr/bin/env bash
# Render the 5-direction x 8-frame walk-cycle motion source with the Windows
# Blender, called headless from WSL (see docs/sprite-generation.md §6).
#
#   bash render.sh [dest-dir]      # frames land in dest-dir (default: $STAGE)
#
# Env: RES=1024 render resolution; BLENDER=/mnt/d/tools/blender/blender.exe
#
# WSL interop (r2, feat/hero-sprites): Blender lives on the WINDOWS host and is
# runnable directly from WSL — NO ssh, NO remote "soul" box. blender.exe is a
# Windows process, so every path handed to it (the .py, the --out dir) must be a
# WINDOWS path: we stage into a Windows-native workdir on D: and pass D:/ paths
# (equivalently `wslpath -w`). The earlier ssh/scp-to-`soul` flow is gone.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-${SWAMPSPACE_STAGE:-/tmp/swampspace-stage}/rotoscope/blender}"
RES="${RES:-1024}"
BLENDER="${BLENDER:-/mnt/d/tools/blender/blender.exe}"
# Windows-native scratch dir readable by the Windows binary as D:/tmp/...
WORK_WSL="${ROTO_WORK:-/mnt/d/tmp/backseat-roto}"
WORK_WIN="$(wslpath -w "$WORK_WSL" 2>/dev/null || echo 'D:\tmp\backseat-roto')"

if [ ! -x "$BLENDER" ]; then
  echo "blender not found at $BLENDER (set BLENDER=...)"; exit 1
fi

mkdir -p "$WORK_WSL/frames"
find "$WORK_WSL/frames" -name 'walk-*.png' -delete 2>/dev/null || true
cp "$HERE/rig_walk.py" "$WORK_WSL/"

# Pass Windows-style paths to the Windows Blender. Forward slashes are accepted
# by Blender's Python on Windows; using the drive-letter form avoids UNC/\\wsl$.
"$BLENDER" -b -P "${WORK_WIN}\\rig_walk.py" -- \
  --out "${WORK_WIN}\\frames" --res "$RES" \
  | grep -E "rendered|RIG_WALK_DONE|Error" || { echo "blender run failed"; exit 1; }

mkdir -p "$DEST"
cp "$WORK_WSL/frames/"walk-*.png "$DEST/"
ls "$DEST" | wc -l
echo "frames -> $DEST"
