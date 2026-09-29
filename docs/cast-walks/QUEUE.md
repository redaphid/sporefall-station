# Cast walk queue (coordinator-owned; one fresh agent per character, serial)

| # | character | archetype(s) | anchor | status |
|---|---|---|---|---|
| 0 | bog-mutant | thug, gangster | r2 (Hulk look) | Step 0 round 1 FAILED (https://2cb.pw/candidates-390b42): all 6 lost the fungus hook and read as the player ranger (slim teal suit, orange visor). Next agent: keep the r2 negatives that block the vine-ranger IPAdapter bleed; put the fungus hook first in a short prompt ("stooped heavy labourer, a shelf of ochre bracket fungus bursting from one shoulder seam"), add `orange` to the negatives, drop the vine-ranger IPAdapter ref to ~0.15 or swap it for the mycologist r2 anchor. Round 1 prompt/graph/script: /mnt/d/tmp/cast-walks/bog-mutant/step0-prompt.json, step0.py. Then Aaron veto, then walk. |
| 1 | mycologist | scientist | r2 | **SHIPPED to main** e82df71+5a2dd1e, live build 714, e-walk-3 sha f865617a verified 03:30. n accepted at seam 0.559 (limit 1.0). Gate fixes 4a/5/6 still landing (tooling, not art). |
| 2 | spore-drone | cop | r2 | **IN PROGRESS** (fresh agent 03:31). generate.py says `cop` is a hovering drone with NO legs, but the r2 sprite has dangling limbs: use a hover/bob `--describe`. |
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
