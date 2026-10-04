import itertools, random
ELEM={'frost','incendiary','shock'}
VERB={'pierce','bounce','homing','explosive','split','splinterShot','detonator','lifesteal'}
STAT={'overload','bulk','rapid','heavy','choke','velocity','glassCannon'}
ALL=sorted(ELEM|VERB|STAT)
def sig(elems, mods):
    return (frozenset(elems), frozenset(m for m in mods if m in VERB))
def default(hand):
    el=[m for m in sorted(hand) if m in ELEM]
    return {sig(el[-1:], hand)}
def casts(seq):
    out=[];cur=[]
    for m in seq:
        cur.append(m)
        if m in ELEM: out.append(cur);cur=[]
    if cur: out.append(cur)
    return out
def sequenced(hand, slots=4):
    s=set()
    for k in range(1,min(slots,len(hand))+1):
        for live in itertools.permutations(hand,k):
            for c in casts(live):
                s.add(sig([m for m in c if m in ELEM], c))
    return s
def lensed(hand, lenspool, slots=4):
    base=sequenced(hand,slots); s=set(base)
    for (els,vs) in base:
        for L in lenspool:
            if L in ELEM:
                if len(els)<2 and L not in els: s.add((els|{L},vs))
            elif L in VERB: s.add((els,vs|{L}))
    return s
random.seed(1)
def avg(f,trials=400,n=5):
    t=0
    for _ in range(trials):
        h=random.sample(ALL,n); t+=f(h)
    return t/trials
print('hand=5 default', avg(lambda h: len(default(h))))
print('hand=5 sequenced', avg(lambda h: len(sequenced(h))))
print('hand=5 seq+own lens', avg(lambda h: len(lensed(h,h))))
def coop(n=5,trials=400):
    t=0
    for _ in range(trials):
        pool=random.sample(ALL,2*n); a,b=pool[:n],pool[n:]
        t+=len(lensed(a,a+b))
    return t/trials
print('hand=5 seq+party lens (per player)', coop())
# global reachable signature space
els=[frozenset()]+[frozenset([e]) for e in ELEM]
pairs=[frozenset(p) for p in itertools.combinations(ELEM,2)]
print('signature universe today', len(els)*2**len(VERB), 'with lens pairs', (len(els)+len(pairs))*2**len(VERB))
