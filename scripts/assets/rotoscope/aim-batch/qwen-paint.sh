#!/usr/bin/env bash
# run under scripts/gpu/gpu-run. usage: qwen-paint.sh OUTTAG SEEDS [design]   (both characters, 5 dirs)
set -u
L=/mnt/d/tmp/cast-walks/GPU-WAN.lock; A=/mnt/d/tmp/cast-walks/aim; W=~/Worktrees/sporefall-station/aim-art-1106
TAG=$1; SEEDS=3,11,23; DES=${3:-}
cd $W/scripts/assets/rotoscope
for C in player:vine-ranger drowner:drowned-diver; do c=${C%:*}; k=${C#*:}
  for d in s se e ne n; do
    desc=$A/$c/describe.txt; case $d in ne|n) desc=$A/$c/describe-back.txt;; esac
    extra=(--weapon "a plain compact dark grey blocky handgun, a simple placeholder shape")
    [ -n "$DES" ] && extra=(--design $DES)
    python3 -u aim_keyframe.py paint /mnt/d/tmp/cast-walks/runs/$k/best-pal/raw/$d-keyframe.png $A/$c/rig/ctl-aim-$d \
      --fit $A/$c/rig/fit-$d.json --dir $d --describe-file $desc --out $A/$c/$TAG --seeds $SEEDS "${extra[@]}" 2>&1 | tr '\r' '\n' | grep -v -i waiting | tail -2
  done
done
echo "QWEN DONE $(date -Iseconds)"
# same GPU batch: provisional keyframe pick by framing, then Fun-Control aim + aimwalk for every view
for c in player drowner; do python3 $A/autopick.py $A/$c; done
specs=(); for c in player drowner; do for d in s se e ne n; do specs+=("$c $d pick 3 t1"); done; done
$A/fc.sh "${specs[@]}"
