#!/usr/bin/env bash
# run under gpu-run: n aim keyframes with the hidden-hands prompt (seeds 31,37), provisional pick, Fun-Control n
set -u
A=/mnt/d/tmp/cast-walks/aim; W=~/Worktrees/sporefall-station/aim-art-1106
cd $W/scripts/assets/rotoscope
for C in player:vine-ranger drowner:drowned-diver; do c=${C%:*}; k=${C#*:}
  mkdir -p $A/$c/kf-n2
  python3 -u aim_keyframe.py paint /mnt/d/tmp/cast-walks/runs/$k/best-pal/raw/n-keyframe.png $A/$c/rig/ctl-aim-n \
    --fit $A/$c/rig/fit-n.json --dir n --describe-file $A/$c/describe-back.txt --out $A/$c/kf-n2 --seeds 31,37 \
    --design /mnt/d/tmp/cast-walks/weapons/lore/pistol-ref-onwhite.png 2>&1 | tr '\r' '\n' | grep -v -i waiting | tail -2
  cp $A/$c/kf-n2/n-aim-s31-848.png $A/$c/kf/n-aim-sn2-848.png
done
rm -f $A/skip-player-n $A/skip-drowner-n
$A/fc.sh "player n n2 3 t1" "drowner n n2 3 t1"
