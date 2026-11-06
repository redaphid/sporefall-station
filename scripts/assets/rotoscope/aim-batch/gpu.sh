#!/usr/bin/env bash
# aim worker: Fun-Control renders under the lock the wait call took.
# usage: gpu.sh "<dir> <seed> <out> <ctl dir> <ref> <describe> <moves file>" ...
set -u
L=/mnt/d/tmp/cast-walks/GPU-WAN.lock; W=~/Worktrees/sporefall-station/aim-art-1106
cd $W/scripts/assets/rotoscope
for spec in "$@"; do
  grep -q "^aim-art-1106 worker" $L || { echo "LOCK NOT OURS: $(cat $L 2>/dev/null)"; exit 3; }
  set -- $spec
  python3 -u fun_control.py --depth $4 --glob 'skel-*.png' --ref $5 --describe-file $6 --dir $1 --seed $2 \
    --moves "$(cat $7)" --out $3 2>&1 | tr '\r' '\n' | grep -v waiting
  echo "$3 rc ${PIPESTATUS[0]} $(date -Iseconds)"; sync
done
curl -s -o /dev/null -w "free %{http_code}\n" -X POST http://127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}'
grep -q "^aim-art-1106 worker" $L && rm -f $L && echo "lock released $(date -Iseconds)"
echo "EXIT $(date -Iseconds)"; sync
