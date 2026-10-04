# Stateful version: one target takes the wand's casts in order for two full loops,
# its status carried between hits, so multi-step combos (Frost, Fire, Shock) count.
from itertools import product
from collections import Counter
import space as S

AFTER = {'CHAIN':'S', 'DEEPFREEZE':'I', 'fizzle':None, 'STEAM':None, 'quench':None,
         'FLASHOVER':'F', 'SHATTER':None, 'CRACK':'W'}

def hit(status, incoming, rx):
    if incoming is None:                       # bare impact
        return ('SHATTER', None) if status == 'I' else (None, status)
    r = rx(status, incoming)
    if r: return (r, AFTER.get(r, None) if rx is S.react else None)
    if status == 'S' and incoming == 'I': return (None, 'S')
    return (None, incoming)

def run(casts, rx):
    status, seen, chain = None, set(), []
    for c in casts * 2:
        els = c[0] or (None,)
        for e in els:
            r, status = hit(status, e, rx)
            if r:
                seen.add(r)
                chain.append(r)
    longest = 0; cur = 0
    for c in casts * 2:
        pass
    return seen, chain

def sweep(alpha, pays, rx):
    per = Counter(); multi = 0; total = 0; three = set()
    for k in range(1, 5):
        for wand in product(alpha, repeat=k):
            total += 1
            casts = S.plan(wand, pays)
            seen, chain = run(casts, rx)
            good = {r for r in seen if r.isupper()}
            for r in good: per[r] += 1
            if len(good) >= 2: multi += 1
            # a three-verb loop: e.g. CRACK then CHAIN within one loop
            if 'CRACK' in good and 'CHAIN' in good: three.add(wand)
    return total, per, multi, len(three)

for name, alpha, pays, rx in [
    ('today-sequence', S.PAY_TODAY + S.SHAPE, S.PAY_TODAY, S.react_today),
    ('design-B      ', S.PAY_B + S.SHAPE + S.GLYPH, S.PAY_B, S.react),
]:
    t, per, multi, three = sweep(alpha, pays, rx)
    print(name, 'wands', t, 'reach', dict(per), 'wands with >=2 reactions', multi, 'crack->chain loops', three)
