# How reaction depth scales with wand length: one 4-slot wand vs two 2-slot wands.
from itertools import product
import space as S
for L in (2, 3, 4, 6):
    plays, names, sigs = set(), set(), set()
    for k in range(1, L + 1):
        for wand in product(S.PAY_B + S.SHAPE + S.GLYPH, repeat=k):
            casts = S.plan(wand, S.PAY_B)
            sigs.add(S.canon(casts))
            for r in S.reactions(casts, S.react):
                if r[0].isupper(): plays.add(r); names.add(r[0])
    print(f'max length {L}: signatures={len(sigs)} reaction-plays={len(plays)} reactions={len(names)}')
