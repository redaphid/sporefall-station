# mireclaw-alpha Step 0 redesign (2026-11-05)

Brief (critic, `/mnt/d/tmp/cast-walks/critique/concept-picks-v3.md`, "Needs a brief"): the mireclaw
matriarch, a squat hunched biped in teal-black chitin plates (no bare muscle), one oversized claw arm
tipped in the orange hot accent, a crest of dorsal spines like the stalker, eyes as two lit dots.
Crouched, wider than tall, every limb >= 6 px at 96 px. Archetype `boss` (speed 3.2, claws, in-game
scale 1.5). PROTOCOL rule 13: it must walk, so two legs.

Lore check (RUNBOOK Step 0):
1. Family B, swamp fauna (the stalker brood's matriarch). Hook: she cracks essence bubbles in one great
   claw, and its tip glows with what it crushes (B: "internal glow only where an animal has swallowed
   something"); she sits in the spore cloud the colony cannot enter and regrows there.
2. Not any other swamp: the stalker's bone-tan spine crest and teal essence-stained chitin (G4) make her
   kin to the brood, and the one orange-lit claw reads in the outline at 96 px.
3. Not the archetype id (`boss` aliases to the hulk `mutant` brief in generate.py; not used).
4. No stock weapon: she claws.
5. Prompt laws: shapes, materials, colours; no creature names; no "silhouette"; drawing, not photo.

Route: RUNBOOK Step 0 still graph, `comfy.build_graph` (checkpoint `juggernautXL_juggXIByRundiffusion`,
the RUNBOOK/`comfy.CKPT` default, not Ragnarok) + skormino pixel LoRA, CFG 3.5, 28 steps, euler.
Tools: `/mnt/d/tmp/cast-walks/mireclaw-alpha/step0-1105/tools/{gen,judge,paint}.py`.

## Round 1 (8 seeds: A 110501 anchor off x4, B 110511 sulphur-mason IPAdapter 0.3 x4)

Contact: `/mnt/d/tmp/cast-walks/mireclaw-alpha/step0-1105/r1/contact.png`. None passes: no candidate drew
the oversized claw (the hook), all eight stand on four planted limbs (not a biped), the anchor pulled B
to grey, and every one has 2-3 px toes (leg p5 1-4 px, limb p10 2-6). A00001 has the best mass (domed
spined head-body, two orange eye dots, thin .030, w/h 1.02): it is the paint-over base for round 2.
