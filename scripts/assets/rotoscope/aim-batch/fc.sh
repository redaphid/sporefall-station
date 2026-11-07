#!/usr/bin/env bash
# Fun-Control aim/aimwalk renders; run under scripts/gpu/gpu-run.
# usage: fc.sh "<char> <dir> <kfseed> <seed> <tag>" ...   (each spec renders aim AND aimwalk)
set -u
A=/mnt/d/tmp/cast-walks/aim; W=~/Worktrees/sporefall-station/aim-art-1106
cd $W/scripts/assets/rotoscope
for spec in "$@"; do
  set -- $spec; c=$1; d=$2; ks=$3; seed=$4; tag=$5
  [ -e $A/skip-$c-$d ] && { echo "skip $c $d"; continue; }
  desc=$A/$c/describe.txt; case $d in ne|n) desc=$A/$c/describe-back.txt;; esac
  ref=$A/$c/kf/$d-aim-s$ks-848.png
  for st in aim aimwalk; do
    ctl=$A/$c/rig/ctl-aim-$d; [ $st = aimwalk ] && ctl=$A/$c/rig/ctl-walk-$d
    out=$A/$c/fc-$tag-$st-$d-s$seed
    python3 -u fun_control.py --depth $ctl --glob 'skel-*.png' --ref $ref --describe-file $desc --dir $d --seed $seed \
      --moves "$(cat $A/moves-$st.txt)" --out $out 2>&1 | tr '\r' '\n' | grep -v -i waiting | tail -2
    echo "$out rc ${PIPESTATUS[0]} $(date -Iseconds)"; sync
  done
done
echo "EXIT $(date -Iseconds)"
