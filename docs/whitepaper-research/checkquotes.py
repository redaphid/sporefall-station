"""Check that every double-quoted span in the whitepaper appears verbatim in a source.

A span is split on ellipses ("..." or "[...]"), and each fragment of 3+ words must
appear, after normalisation, in at least one evidence file. Prints the misses.
"""
import json
import re
import sys
from pathlib import Path

S = Path('/tmp/claude-1000/-home-hypnodroid-Worktrees-sporefall-station-poteto/371760c2-4ad8-4e6c-b110-13ca021f769e/scratchpad')
REPO = Path('/home/hypnodroid/Projects/sporefall-station/.claude/worktrees/agent-a2d4c10b079f7a447')
PAPER = REPO / 'docs/WHITEPAPER.md'

sources = [
    *sorted((S / 'whitepaper-research').glob('lane*.md')),
    S / 'INSPO.md', S / 'arena-census.md', S / 'substrate-census.md',
    S / 'loadout-design/BRIEF.md', S / 'loadout-design/design-B.md',
    REPO / 'docs/LORE.md', REPO / 'docs/design/boss-variety.md',
]
corpus_parts = [p.read_text() for p in sources if p.exists()]
results = json.loads((S / 'loadout-design/playtest-results.json').read_text())
corpus_parts.append(json.dumps(results, ensure_ascii=False))
for v in results.values():
    for x in v.values():
        if isinstance(x, str):
            corpus_parts.append(x)


def norm(t: str) -> str:
    t = t.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
    t = t.replace('\\"', '"').replace('\\n', ' ')
    t = re.sub(r'[*_`>]', '', t)
    t = re.sub(r'\s+', ' ', t)
    return t.lower().strip(' .,;:')


corpus = norm(' '.join(corpus_parts))
text = PAPER.read_text()
misses = []
for m in re.finditer(r"\"([^\"]*)\"", text):
    span = m.group(1)
    line = text.count('\n', 0, m.start()) + 1
    for frag in re.split(r'\.\.\.|\[\.\.\.\]|\[[^\]]*\]', span):
        f = norm(frag)
        if len(f.split()) < 3:
            continue
        if f not in corpus:
            misses.append((line, f))
for line, f in misses:
    print(f'{line}: {f}')
print(f'{len(misses)} unmatched fragments', file=sys.stderr)
