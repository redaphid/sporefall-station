# Counts the combinatorial space of a 4-slot wand under three rule sets:
#   today-default  : every mod folds into every shot, one element wins (resolveWeapon)
#   today-sequence : modSequence.ts as shipped behind the flag
#   design-B       : water payload + reaction matrix + Twin/Trail/Relay glyphs
# Stat mods are collapsed into one STAT class on purpose: this counts verbs, not numbers.
from itertools import product

PAY_TODAY = ['I', 'F', 'S']            # frost, incendiary, shock
PAY_B = ['W', 'I', 'F', 'S']           # + water (soak)
SHAPE = ['AREA', 'LINE', 'SEEK', 'STAT', 'DET']
GLYPH = ['TWIN', 'TRAIL', 'RELAY']

def react(primer, incoming):
    """Status already on the target x element arriving. None = no reaction."""
    if primer is None: return None
    if primer == 'I': return 'CRACK' if incoming == 'F' else 'SHATTER'
    table = {('W','S'):'CHAIN', ('W','I'):'DEEPFREEZE', ('W','F'):'fizzle',
             ('F','W'):'STEAM', ('F','I'):'quench', ('F','S'):'FLASHOVER'}
    return table.get((primer, incoming))

def react_today(primer, incoming):
    # Only shatter is reachable from a wand today: nothing a player fires makes a body wet.
    return 'SHATTER' if primer == 'I' else None

def plan(wand, pays):
    """Split a wand into casts. Each cast: (elements tuple, shapes frozenset, flags)."""
    casts, cur_sh, cur_el, twin, trail, relay_next = [], set(), [], False, False, False
    relay_in = False
    for s in wand:
        if s in pays:
            cur_el.append(s)
            if twin and len(cur_el) < 2: continue
            flags = frozenset(x for x, on in (('trail', trail), ('relay_in', relay_in)) if on)
            casts.append((tuple(cur_el), frozenset(cur_sh), flags, relay_next))
            relay_in, cur_sh, cur_el, twin, trail = relay_next, set(), [], False, False
            relay_next = False
        elif s == 'TWIN': twin = True
        elif s == 'TRAIL': trail = True
        elif s == 'RELAY': relay_next = True
        else: cur_sh.add(s)
    if cur_sh or cur_el or twin or trail:
        flags = frozenset(x for x, on in (('trail', trail), ('relay_in', relay_in)) if on)
        casts.append((tuple(cur_el), frozenset(cur_sh), flags, relay_next))
    return [(e, sh, fl) for e, sh, fl, _ in casts]

def delivery(cast):
    e, sh, fl = cast
    if 'trail' in fl: return 'ground'
    if 'relay_in' in fl: return 'relay'
    if len(e) == 2: return 'twin'
    for k in ('AREA', 'LINE', 'SEEK'):
        if k in sh: return k.lower()
    return 'single'

def canon(casts):
    rots = [tuple(casts[i:] + casts[:i]) for i in range(len(casts))] or [()]
    return min(rots, key=repr)

def reactions(casts, rx):
    out = set()
    n = len(casts)
    for i, c in enumerate(casts):
        e = c[0]
        if len(e) == 2:                                   # twin: same-tick, in order
            r = rx(e[0], e[1])
            if r: out.add((r, 'twin', 'twin'))
        if n < 2 and len(e) < 2:
            if n == 1 and e:                               # a one-cast wand repeats itself
                r = rx(e[-1], e[0])
                if r: out.add((r, delivery(c), delivery(c)))
            continue
        nxt = casts[(i + 1) % n] if n > 1 else None
        if nxt is None or not e: continue
        incoming = nxt[0][0] if nxt[0] else None
        r = rx(e[-1], incoming) if incoming else ('SHATTER' if e[-1] == 'I' else None)
        if r: out.add((r, delivery(c), delivery(nxt)))
    return out

def sweep(alpha, pays, rx, sequenced):
    sigs, plays, rnames = set(), set(), set()
    for k in range(1, 5):
        for wand in product(alpha, repeat=k):
            if sequenced:
                casts = plan(wand, pays)
                sigs.add(canon(casts))
                rs = reactions(casts, rx)
            else:  # default fold: set semantics, one element wins (sorted id: frost<incendiary<shock)
                els = [p for p in pays if p in wand]
                win = els[-1] if els else None
                sh = frozenset(s for s in wand if s in SHAPE)
                casts = [((win,) if win else (), sh, frozenset())]
                sigs.add(tuple(casts))
                rs = reactions(casts, rx)
            for r in rs:
                plays.add(r)
                if r[0].isupper(): rnames.add(r[0])
    good = {p for p in plays if p[0].isupper()}
    return len(sigs), len(good), sorted(rnames)

for name, alpha, pays, rx, seq in [
    ('today-default ', PAY_TODAY + SHAPE, PAY_TODAY, react_today, False),
    ('today-sequence', PAY_TODAY + SHAPE, PAY_TODAY, react_today, True),
    ('design-B      ', PAY_B + SHAPE + GLYPH, PAY_B, react, True),
]:
    s, p, r = sweep(alpha, pays, rx, seq)
    print(f'{name}  distinct casts-signatures={s:6d}  reaction-plays={p:4d}  reactions={r}')
