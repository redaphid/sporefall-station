#!/usr/bin/env bash
# Post a comment on a PR, or EDIT the one this workflow already posted.
#
#   bash .github/scripts/sticky-comment.sh <pr-number> <body-file>
#
# WHY "STICKY" IS THE WHOLE POINT. The beta is republished on every push, so a
# plain `gh pr comment` would leave a PR with twenty near-identical comments,
# nineteen of them pointing at builds that no longer exist. Reviewers stop
# reading a thread that does that, and the newest URL — the only one that is
# true — is the hardest one to find in it. So: one comment per PR, found by an
# invisible HTML marker in its body and rewritten in place.
#
# The marker is an HTML comment, so it is in the body (which is what the API
# searches) and invisible in the rendered comment. It is matched anywhere in the
# body rather than at a fixed offset so the layout above it can change freely.
#
# Deliberately `gh api` and not an Action: this repo adds no dependencies for
# this, and `gh` is preinstalled on every GitHub-hosted runner.
#
# Requires GH_TOKEN with `pull-requests: write`. A FORK's pull_request run has
# neither, which is why .github/workflows/preview-web.yml never reaches here on
# one — see its `fork-note` job.

set -euo pipefail

MARKER='<!-- sporefall-beta-url: do not remove, this comment is rewritten in place -->'

PR="${1:?usage: sticky-comment.sh <pr-number> <body-file>}"
BODY_FILE="${2:?usage: sticky-comment.sh <pr-number> <body-file>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

[ -f "$BODY_FILE" ] || { echo "sticky-comment: no such body file: $BODY_FILE" >&2; exit 1; }

WITH_MARKER="$(mktemp)"
{ cat "$BODY_FILE"; printf '\n%s\n' "$MARKER"; } > "$WITH_MARKER"

# `--paginate` streams one id per line across every page; the oldest match wins,
# so a marker that somehow ended up on two comments converges on one rather than
# flip-flopping between them.
EXISTING="$(
  gh api --paginate "repos/$REPO/issues/$PR/comments" \
    --jq ".[] | select(.body != null and (.body | contains(\"sporefall-beta-url\"))) | .id" \
    2>/dev/null | head -n 1 || true
)"

if [ -n "$EXISTING" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$EXISTING" -F "body=@$WITH_MARKER" --silent
  echo "sticky-comment: edited comment $EXISTING on #$PR"
else
  gh api -X POST "repos/$REPO/issues/$PR/comments" -F "body=@$WITH_MARKER" --silent
  echo "sticky-comment: posted a new comment on #$PR"
fi
