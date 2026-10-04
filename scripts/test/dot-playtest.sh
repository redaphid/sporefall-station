#!/usr/bin/env bash
# Headless playtest of damage over time (#bug: DoT never stopped regen, low
# resist rounded a burn to zero). Drives scripts/playtest.mts, one verb per
# call, so every number below comes from the same CLI a playtester uses.
#
#   bash scripts/test/dot-playtest.sh [outdir]
#
# stand   The player stands still in a burning cell until the burn ends.
# roll    The player catches fire, steps out east, and rolls the burn out.
# cinders An Incendiary pistol against a pack of 4 cinders, then 4 thugs.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=${1:-$(mktemp -d)}
mkdir -p "$out"
pt() { npx tsx scripts/playtest.mts "$@"; }
# A body swept from the world after death is "dead" too: `get` no longer finds it.
hp() {
  local j
  j=$(pt "$1" get "$2" 2>/dev/null) || { printf dead; return; }
  node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(e.dead?"dead":e.playerCtl?.downed?"downed":`${e.health.hp}`)' <<<"$j"
}
burning() { pt "$1" get "$2" | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(e.fx?.burning?"burning":"-")'; }

# A world with the player (id 171 on seed 5) standing in a freshly lit cell.
lit_world() {
  pt "$1" new --seed 5 >/dev/null
  pt "$1" spawn fire fire 1.5 1.5 >/dev/null
  pt "$1" set 172 '{"fire":{"fuel":360}}' >/dev/null
}

timeline() { # file label ticks-per-sample samples
  local f=$1 label=$2 every=$3 n=$4 min=120 line="" h
  for ((i = 1; i <= n; i++)); do
    pt "$f" step "$every" '{}' >/dev/null
    h=$(hp "$f" 171)
    [[ $(burning "$f" 171) == burning ]] && h+='*'
    line+=" $h"
    h=${h%\*}
    [[ $h =~ ^[0-9]+$ ]] && ((h < min)) && min=$h
    [[ $h == downed || $h == dead ]] && { min=0; break; }
  done
  echo "$label: hp every $every ticks (* = burning):$line"
  echo "$label: low $min/120"
}

echo "== stand: still in a burning cell =="
lit_world "$out/stand.json"
timeline "$out/stand.json" stand 30 40

echo "== roll: catch fire, step out east, roll it out =="
lit_world "$out/roll.json"
pt "$out/roll.json" step 1 '{}' >/dev/null
pt "$out/roll.json" step 18 '{"moveX":1}' >/dev/null
for dir in 1 -1 1 -1; do
  pt "$out/roll.json" step 1 "{\"moveX\":$dir,\"roll\":true}" >/dev/null
  pt "$out/roll.json" step 35 '{}' >/dev/null
done
echo "roll: after 4 rolls hp $(hp "$out/roll.json" 171) $(burning "$out/roll.json" 171) at tick $(pt "$out/roll.json" state | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).tick))')"
timeline "$out/roll.json" roll 30 20

pack_ttk() { # file archetype
  local f=$1 arch=$2 ids=() t0 tick
  pt "$f" new --seed 5 >/dev/null
  pt "$f" addMod 171 incendiary >/dev/null
  for y in 4.5 5.5 6.5 7.5; do
    ids+=("$(pt "$f" spawn npc "$arch" 7.5 "$y" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).id))')")
  done
  local kills=""
  for id in "${ids[@]}"; do
    for ((n = 0; n < 100; n++)); do
      [[ $(hp "$f" "$id") == dead ]] && break
      pt "$f" step 3 "{\"aimAt\":$id,\"attack\":true}" >/dev/null
    done
    kills+=" $(pt "$f" state | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).tick))')"
  done
  echo "$arch pack (4, Incendiary pistol): kills by tick:$kills (3-tick steps), player hp $(hp "$f" 171)"
}

echo "== cinders vs thugs: time to kill a pack of 4 =="
pack_ttk "$out/cinders.json" cinder
pack_ttk "$out/thugs.json" thug
echo "state files: $out"
