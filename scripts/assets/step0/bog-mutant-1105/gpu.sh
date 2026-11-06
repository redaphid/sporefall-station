#!/usr/bin/env bash
# bog-mutant 11-05 redesign: concept_to_input per concept, seeds 3 11 23; takes and releases GPU-WAN.lock per concept batch.
set -u
D=/mnt/d/tmp/cast-walks/bog-mutant/redesign-1105; L=/mnt/d/tmp/cast-walks/GPU-WAN.lock; A=/mnt/d/Projects/sporefall-art
W=~/Worktrees/sporefall-station/bog-mutant-1105/scripts/assets
LU=bog-mutant,bog-mender,drowned-diver,mycologist,bellwether,vine-ranger
run() {
  while [ -e $L ]; do sleep 10; done
  echo "bog-mutant-1105 worker | bog-mutant | $1 | $(date -Iseconds)" > $L
  python3 -u $W/concept_to_input.py $A/$2 --kind bog-mutant --out $D/$1 --seeds 3 11 23 --describe "$(cat $D/$3)" --lineup $LU 2>&1 | tail -6
  echo "$1 rc ${PIPESTATUS[0]} $(date -Iseconds)"
  curl -s -o /dev/null -w "free %{http_code}\n" -X POST http://127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":false,"free_memory":true}'
  grep -q "^bog-mutant-1105 worker" $L && rm -f $L && echo "lock released $(date -Iseconds)"
}
run a-pod assets/identity/lore/pod-carrier_seed412.png a-pod.txt
run b-jar assets/identity/watched/cargo-harness.png b-jar.txt
run c-seal assets/identity/watched/the-seal-one.png c-seal.txt
curl -s -o /dev/null -w "free-all %{http_code}\n" -X POST http://127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}'
echo "EXIT $(date -Iseconds)"; sync
