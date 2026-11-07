#!/usr/bin/env bash
# post.sh CHAR DIR STATE RUN CLIP_IDX OUT [extra args]   (CPU: cast_action post with the aim defaults)
set -eu
A=/mnt/d/tmp/cast-walks/aim; c=$1; d=$2; st=$3; run=$4; idx=$5; out=$6; shift 6
k=vine-ranger; [ $c = drowner ] && k=drowned-diver
P=(); for v in e se s ne; do P+=(--palette-add $A/rivet/rivetDriver-$v-idle-0.png); done
ctl=$A/$c/rig/ctl-aim-$d; [ $st != aim ] && ctl=$A/$c/rig/ctl-walk-$d
cd ~/Worktrees/sporefall-station/aim-art-1106/scripts/assets
python3 cast_action.py post /mnt/d/tmp/cast-walks/runs/$k/best-pal --kind $k --state $st --clip $d=$run:$idx \
  --props $d=$ctl --no-paint "${P[@]}" --out $out "$@" 2>&1 | tail -3
