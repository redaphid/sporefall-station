# Variant: SHATTER needs a BARE (element-free) impact. An element landing on ice either
# reacts (Fire: CRACK) or is wasted. Tests whether that breaks Frost's universal-primer lead.
import space as S, space2 as S2
orig = S.react
def react_bare(primer, incoming):
    if primer == 'I': return 'CRACK' if incoming == 'F' else None
    return orig(primer, incoming)
S.react = react_bare
t, per, multi, three = S2.sweep(S.PAY_B + S.SHAPE + S.GLYPH, S.PAY_B, react_bare)
print('design-B/bare-shatter wands', t, 'reach', dict(per), '>=2 reactions', multi, 'crack->chain', three)
