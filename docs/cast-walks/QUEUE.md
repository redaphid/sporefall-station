# Cast walk queue (coordinator-owned; one fresh agent per character, serial)

Order from 07:40: two-legged humanoids first (they loop: mycologist, player), then many-legged walkers (stalker proves or parks the scuttle gait; fallback = rotoscope route), non-walkers (hover/pulse, unsolved) last.
Next humanoids, in order: drowned-diver (drowner), blast-diver (breacher), bog-mender (mender), cinder-husk (cinder), bellwether, bog-mutant (needs its redesign + Aaron veto first).

| # | character | archetype(s) | anchor | status |
|---|---|---|---|---|
| 0 | bog-mutant | thug, gangster | r2 (Hulk look) | Step 0 round 1 FAILED (https://2cb.pw/candidates-390b42): all 6 lost the fungus hook and read as the player ranger (slim teal suit, orange visor). Next agent: keep the r2 negatives that block the vine-ranger IPAdapter bleed; put the fungus hook first in a short prompt ("stooped heavy labourer, a shelf of ochre bracket fungus bursting from one shoulder seam"), add `orange` to the negatives, drop the vine-ranger IPAdapter ref to ~0.15 or swap it for the mycologist r2 anchor. Round 1 prompt/graph/script: /mnt/d/tmp/cast-walks/bog-mutant/step0-prompt.json, step0.py. Then Aaron veto, then walk. |
| 1 | mycologist | scientist | r2 | **DONE e2e**: main f24515d (build 723), gates 9/9 in 194 s, in-game video https://2cb.pw/mycologist-walk-ingame-9e945d, e-walk-3 sha f865617a live == commit |
| 2 | spore-drone | cop | r2 | **PARKED 05:40** after 7 takes / 3 hover motions: no loop <= 0.5 in se/e/ne (best .757/.662/1.89), n shows lamps from behind. Best unexported: runs/spore-drone/best-pal, sheet https://2cb.pw/contact-96-vs-frog-settler-2ad414. Unpark needs: hover seam limit from Aaron, a rigid-limbed redesign, or s-only. Also: npcs.ts gives cop a `bat` (Aaron: not a bat) -> feat/lore-weapons. |
| 2b | vine-ranger | player | key art hero (Aaron 04:3x) | **DONE e2e** 07:2x: R1 (braid, quilted vest, hip jar), main ecc03e2 (build 747), gates 9/9, e-walk-3 d4bc56c6 + s-idle 108569aa live == main, in-game https://2cb.pw/player-walk-0fd5c7 |
| 3 | mireclaw-stalker | stalker | r2 | queued |
| 4 | sporeling-mite | sporeling | r2 | queued |
| 5 | carapace-brute | brute | r2 | queued |
| 6 | derelict-bot | robot | r2 | queued |
| 7 | cinder-husk | cinder | r2 | queued |
| 8 | brood-sac | pod | r2 | queued (non-walker: idle pulse) |
| 9 | gloam-hound | gloamhound | shipped s-idle | queued |
| 10 | drowned-diver | drowner | shipped s-idle | queued |
| 11 | blast-diver | breacher | shipped s-idle | queued |
| 12 | bog-mender | mender | shipped s-idle | queued |
| 13 | bellwether | bellwether | shipped s-idle | queued |
| 14 | mireclaw-alpha | boss | shipped s-idle | queued |
| 15 | spore-mortar | lobber | shipped s-idle | queued |
| 16 | gloom-lurker | lurker | shipped s-idle | queued (non-walker) |
| 17 | hive-spire | hivespire | shipped s-idle | queued (non-walker, speed 0) |
