# Cast walk queue (coordinator-owned; one fresh agent per character, serial)

Order from 07:40: two-legged humanoids first (they loop: mycologist, player), then many-legged walkers (stalker proves or parks the scuttle gait; fallback = rotoscope route), non-walkers (hover/pulse, unsolved) last.
Next humanoids, in order: drowned-diver (drowner), blast-diver (breacher), bog-mender (mender), cinder-husk (cinder), bellwether, bog-mutant (needs its redesign + Aaron veto first).

| # | character | archetype(s) | anchor | status |
|---|---|---|---|---|
| 0 | bog-mutant | mutant, acolyte | r2 (Hulk look) | Step 0 round 1 FAILED (https://2cb.pw/candidates-390b42): all 6 lost the fungus hook and read as the player ranger (slim teal suit, orange visor). Next agent: keep the r2 negatives that block the vine-ranger IPAdapter bleed; put the fungus hook first in a short prompt ("stooped heavy labourer, a shelf of ochre bracket fungus bursting from one shoulder seam"), add `orange` to the negatives, drop the vine-ranger IPAdapter ref to ~0.15 or swap it for the mycologist r2 anchor. Round 1 prompt/graph/script: /mnt/d/tmp/cast-walks/bog-mutant/step0-prompt.json, step0.py. Then Aaron veto, then walk. |
| 1 | mycologist | scientist | r2 | **DONE e2e**: main f24515d (build 723), gates 9/9 in 194 s, in-game video https://2cb.pw/mycologist-walk-ingame-9e945d, e-walk-3 sha f865617a live == commit |
| 2 | spore-drone | warden | r2 | **PARKED 05:40** after 7 takes / 3 hover motions: no loop <= 0.5 in se/e/ne (best .757/.662/1.89), n shows lamps from behind. Best unexported: runs/spore-drone/best-pal, sheet https://2cb.pw/contact-96-vs-frog-settler-2ad414. Unpark needs: hover seam limit from Aaron, a rigid-limbed redesign, or s-only. Also: npcs.ts gives the drone a stock club (Aaron rejected it) -> feat/lore-weapons. |
| 2b | vine-ranger | player | key art hero (Aaron 04:3x) | **DONE e2e** 07:2x: R1 (braid, quilted vest, hip jar), main ecc03e2 (build 747), gates 9/9, e-walk-3 d4bc56c6 + s-idle 108569aa live == main, in-game https://2cb.pw/player-walk-0fd5c7 |
| 3 | mireclaw-stalker | stalker | r2 | **PARKED 07:45** after 3 takes on se (walk s3, walk s11, scuttle s3), 2 on s/e/ne; n take1 .983 PASS. Wan steps each of the eight legs at its own phase, so no loop point exists: best single-frame seam anywhere se 1.51/1.32/1.56, ne 2.00/1.15, s .48/1.45, e .50/.74 (legs .49-1.78 vs the mycologist's .12-.29; the carapace loops, s .32 e .27). A two-group "scuttle" gait sentence made se worse (2.70), so it was removed. Best unexported: runs/mireclaw-stalker/best-pal, sheet https://2cb.pw/contact-96-vs-frog-settler-70e8c5, GIF https://2cb.pw/walk-96-vs-frog-settler-0bd549. Game unchanged: stalker still draws its s-idle. Also: npcs.ts stalker `weapon: 'knife'` draws a blade on a beast -> feat/lore-weapons. |
|   | **unpark path: rotoscope** | stalker, mireclaw-alpha, sporeling-mite, gloam-hound (any many-legged or four-legged walker) | | Periodic by construction, so the seam problem cannot occur. Route: `scripts/assets/rotoscope/` (docs/sprite-generation.md §6; the shipped vine-ranger cycle came from it). Needs: (1) a new proxy in `rig_walk.py` beside the humanoid one: domed carapace ellipsoid, wedge head, bone spine cones, 8 legs of 3 FK segments, colour-blocked from the r2 anchor (teal top, charcoal tips, bone spines), proportions from the s-idle row profile (§6 box: the proxy silhouette IS the shipped silhouette); (2) an alternating-tetrapod gait (L1 R2 L3 R4 swing while the other four stand, then swap) as 8 explicit poses, body height constant, stance feet pinned to the ground; (3) Blender 5.x headless on Windows (`/mnt/d/tools/blender/blender.exe`, render.sh), depth pass on; (4) `trace.py` with the r2 anchor as IPAdapter and depth ControlNet (CN_DENOISE 0.85); (5) an adapter so `cast_walk.py assemble/export` take the traced 8-frame loops (it reads video-sN runs today), then the same 9 gates unchanged. Estimate: one worker, ~2 h to the first gated direction. |
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
