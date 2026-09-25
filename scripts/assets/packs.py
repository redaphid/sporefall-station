#!/usr/bin/env python3
"""Theme-pack awareness for the generation pipeline.

WHY THIS EXISTS. On 2026-08-23 nine regenerated sprites were written into
`public/themes/swampspace` and nobody saw them. The game defaults to
`swampspace-hires`, and theme resolution answers from the FIRST manifest that
MENTIONS a key (src/render/theme.ts). So the base-pack art was shadowed.

Nothing failed. The merge was correct, the deploy was green, the gates were
green, the browser was fresh -- and the player saw August art. That is the
failure this module exists to make impossible to do quietly.

The fix is deliberately NOT "point the pipeline at hires". Pointing it at the
right pack fixes today; refusing to write art that something else will shadow
fixes every future variant, including packs nobody has created yet.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
THEMES = os.path.join(REPO, "public", "themes")
THEME_TS = os.path.join(REPO, "src", "render", "theme.ts")

BASE_PACK = "swampspace"


class ShadowedWrite(RuntimeError):
    """Raised when art would be written where a higher-priority pack hides it."""


def default_pack():
    """The pack the GAME loads, read from theme.ts rather than duplicated here.

    Duplicating it is how this bug happens a second time: a constant copied into
    the pipeline drifts from the one the app uses, and the drift is invisible
    until someone looks at the screen."""
    src = open(THEME_TS, encoding="utf-8").read()
    m = re.search(r"DEFAULT_THEME_ID\s*=\s*['\"]([^'\"]+)['\"]", src)
    if not m:
        raise RuntimeError(
            f"could not read DEFAULT_THEME_ID from {THEME_TS} -- refusing to guess "
            "which pack the game loads")
    return m.group(1)


def chain(active=None):
    """Resolution order, highest priority first: active pack, then the base pack
    it falls back to. Mirrors resolveSpritePaths in theme.ts."""
    active = active or default_pack()
    return [active] if active == BASE_PACK else [active, BASE_PACK]


def sprite_keys(pack):
    p = os.path.join(THEMES, pack, "manifest.json")
    if not os.path.exists(p):
        return set()
    return set(json.load(open(p, encoding="utf-8")).get("sprites", {}))


def shadows(target_pack, keys, active=None):
    """Which of `keys` written into `target_pack` would be hidden, and by whom.

    Returns {key: shadowing_pack}. A key is shadowed when some pack STRICTLY
    ahead of the target in the chain mentions it at all -- mentioning is enough,
    because first-mention wins."""
    order = chain(active)
    if target_pack not in order:
        # Not in the chain at all: everything written there is dead art.
        return {k: order[0] for k in keys}
    ahead = order[: order.index(target_pack)]
    out = {}
    for pack in ahead:
        have = sprite_keys(pack)
        for k in keys:
            if k in have and k not in out:
                out[k] = pack
    return out


def assert_writable(target_pack, keys, active=None):
    """Refuse, loudly and by name, to write art the player will never see.

    This is the whole point: a warning would be read as noise at 3am. The run
    should stop before spending two hours producing invisible art."""
    hidden = shadows(target_pack, keys, active)
    if not hidden:
        return
    who = sorted(set(hidden.values()))
    sample = sorted(hidden)[:5]
    raise ShadowedWrite(
        f"{len(hidden)} sprite key(s) written into '{target_pack}' would be "
        f"SHADOWED by {who} -- the game resolves them from there first, so this "
        f"art would never appear. Examples: {sample}. "
        f"Write into {who[0]} instead, or post to it as well "
        f"(scripts/assets/hires_chars.py).")
