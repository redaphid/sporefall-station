#!/usr/bin/env python3
"""Finish the hi-res swampspace theme without more GPU:
  1. Derive each NPC's s-step from its freshly regenerated hi-res s-idle
     (the deterministic gait shift the engine uses for NPCs anyway).
  2. Regenerate every procedural FX at 2× px.
"""
import os
import sys

HERE = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets"
sys.path.insert(0, HERE)
from PIL import Image  # noqa: E402
import post as P       # noqa: E402
import procedural as PR  # noqa: E402

HIRES = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/public/themes/swampspace-hires"
CHARS = os.path.join(HIRES, "chars")

NPCS = ["bog-mutant", "spore-drone", "mycologist", "derelict-bot", "frog-settler"]
for kind in NPCS:
    idle = os.path.join(CHARS, f"{kind}-s-idle.png")
    if not os.path.exists(idle):
        print(f"skip {kind}: no hi-res idle")
        continue
    step = P.derive_step(Image.open(idle).convert("RGBA"))
    step.save(os.path.join(CHARS, f"{kind}-s-step.png"))
    print(f"derived {kind}-s-step ({step.size[0]}px)")

# FX at 2× (defaults were 48/56/16/20/48/64 → double each)
PR.THEME = HIRES
PR.hit_spark(px=96)
PR.pickup_sparkle(px=96)
PR.ichor_splat(px=112)
PR.projectile(px=32)
PR.grenade_ball(px=40)
PR.biolume_flame(px=96)
PR.spore_burst(px=128)
print("FX regenerated at 2x into", HIRES)
