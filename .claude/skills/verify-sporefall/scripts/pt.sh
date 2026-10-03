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
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

name="${1:?usage: pt.sh <name> <verb> [args…]}"
shift
DIR="e2e/output/verify/pt-$name"
mkdir -p "$DIR"
[ "${1:-}" = new ] && : >"$DIR/transcript.log"

reply=$(npx tsx scripts/playtest.mts "$DIR/world.json" "$@")
printf '$ %s\n%s\n\n' "$*" "$reply" >>"$DIR/transcript.log"
echo "$reply"
