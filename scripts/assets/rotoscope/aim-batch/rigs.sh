#!/usr/bin/env bash
# rebuild every aim/aimwalk control + paint-over for both characters
set -e
A=/mnt/d/tmp/cast-walks/aim; cd ~/Worktrees/sporefall-station/aim-art-1106/scripts/assets/rotoscope
for C in player:vine-ranger drowner:drowned-diver; do c=${C%:*}; k=${C#*:}; R=$A/$c/rig
  for spec in s:0 se:26 e:0 ne:-26 n:0; do d=${spec%:*}; y=${spec#*:}
    rm -rf $R/ctl-aim-$d $R/ctl-walk-$d
    python3 rig_action.py $R/fit-$d.json aim --period 81 --yaw $y --out $R/ctl-aim-$d >/dev/null
    python3 skeleton.py $R/ctl-aim-$d --stick 5 --ref $R/kf-$d-848.png >/dev/null
    python3 rig_action.py $R/fit-$d.json aimwalk --period 24 --stride ${STRIDE:-55} --yaw $y --out $R/ctl-walk-$d >/dev/null
    python3 skeleton.py $R/ctl-walk-$d --stick 5 --ref $R/kf-$d-848.png >/dev/null
    desc=$A/$c/describe.txt; case $d in ne|n) desc=$A/$c/describe-back.txt;; esac
    python3 aim_keyframe.py paint /mnt/d/tmp/cast-walks/runs/$k/best-pal/raw/$d-keyframe.png $R/ctl-aim-$d --fit $R/fit-$d.json --dir $d --describe-file $desc --out $A/$c/kf --paint-only
  done
  python3 $A/overlays.py $R $R/overlays.png
  python3 -c "
from PIL import Image
ims=[Image.open(f'$A/$c/kf/{d}-paint.png').crop((280,0,1000,720)).resize((360,360)) for d in ['s','se','e','ne','n']]
s=Image.new('RGB',(1800,360));[s.paste(im,(i*360,0)) for i,im in enumerate(ims)];s.save('$A/$c/kf/paint-strip.png')"
done
python3 -c "
from PIL import Image
a=Image.open('$A/player/kf/paint-strip.png');b=Image.open('$A/drowner/kf/paint-strip.png');s=Image.new('RGB',(1800,720));s.paste(a,(0,0));s.paste(b,(0,360));s.save('$A/paint-strips.png')"
