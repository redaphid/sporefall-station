#!/usr/bin/env bash
# Headless playtest with evidence: scripts/playtest.mts against a world file that
# lives in this run's evidence dir, with every call and reply appended to a transcript.
#
#   pt.sh <name> new [--seed N] [--scenario NAME] [--floor F]
#   pt.sh <name> look [radius]
#   pt.sh <name> step 90 '{"aimAt":223,"attack":true}'
#   pt.sh <name> <any debug verb line>        (spawn, addMod, get, entities, …)
#
# Evidence: e2e/output/verify/pt-<name>/{world.json,transcript.log}. `new` starts a
# fresh transcript; the world file is the exact end state and reloads with `look`.
# A failing call is logged too, with its exit code, and pt.sh exits with that code.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

name="${1:?usage: pt.sh <name> <verb> [args…]}"
case "$name" in */* | *..*) echo "pt.sh: name must not contain '/' or '..': $name" >&2; exit 2 ;; esac
shift
DIR="e2e/output/verify/pt-$name"
mkdir -p "$DIR"
[ "${1:-}" = new ] && : >"$DIR/transcript.log"

rc=0
reply=$(npx tsx scripts/playtest.mts "$DIR/world.json" "$@" 2>&1) || rc=$?
if [ "$rc" -eq 0 ]; then
  printf '$ %s\n%s\n\n' "$*" "$reply" >>"$DIR/transcript.log"
else
  printf '$ %s\n[exit %s]\n%s\n\n' "$*" "$rc" "$reply" >>"$DIR/transcript.log"
fi
echo "$reply"
exit "$rc"
