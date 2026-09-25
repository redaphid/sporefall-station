#!/usr/bin/env bash
# Materialise the BEFORE side of the tween A/B: a verbatim copy of the client as
# it stood on the given ref (default origin/main), with its imports repointed.
# Generated, never committed — so the baseline is always real code, not a stale
# hand-copy that could drift into asserting against a private fork of the bug.
set -euo pipefail
REF="${1:-origin/main}"
cd "$(dirname "$0")/../.."
mkdir -p tools/tween/baseline
git show "$REF:src/app/netClient.ts" \
  | sed -e "s#from '\.\./game/#from '../../../src/game/#g" \
        -e "s#from '\.\./input/#from '../../../src/input/#g" \
        -e "s#from '\.\./net/#from '../../../src/net/#g" \
        -e "s#from '\./session'#from '../../../src/app/session'#g" \
  > tools/tween/baseline/netClientBaseline.ts
echo "wrote tools/tween/baseline/netClientBaseline.ts from $REF"
