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
| 7 | cinder-husk | cinder | r2 | gating; Aaron 09-29 20:2x "fine for now, revisit later": ships for testing, redesign later (thin, reads nude) |
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

## Order from 10:10 (critic grades, PROTOCOL rules 11-12)

Grades: /mnt/d/tmp/cast-walks/critique/CRITIQUE.md, lineup https://2cb.pw/sporefall-cast-grades.
Done or in flight: mycologist B, vine-ranger B, drowned-diver C, blast-diver B (all on main);
mireclaw-stalker C (shipping, Aaron's loop exception), sporeling-mite C (waddle; motion fix 028ee9a),
cinder-husk C (rendering), bellwether B (staged).
Not yet animated, in critic order (A/B first, C/D/F last; all get animated for testing, weak ones then redesigned):
1. mireclaw-alpha B (many legs: least-bad loop for testing, rule 11)
2. gloom-lurker B (hover: least-bad loop for testing)
3. carapace-brute C (quadruped)
4. spore-mortar C
5. derelict-bot C
6. gloam-hound C (quadruped)
7. bog-mender C (Step 0 prep saved in /mnt/d/tmp/cast-walks/bog-mender/)
8. spore-drone C (parked hover; least-bad loop for testing)
9. brood-sac D (stationary: pulse loop)
10. hive-spire D (stationary: pulse loop)
11. bog-mutant F (the Hulk; redesign first, Aaron veto)
Redesign references: the critic's concept-art picks, /mnt/d/tmp/cast-walks/critique/concept-picks.md (in progress).
Cleanup (critic): legacy step/attack frames for bog-mutant, derelict-bot and spore-drone are an older design, not in the manifest; delete them so nobody animates from them.

## Rounds (Aaron, 2026-09-29 ~10:25, corrected ~10:30)

Aaron: "We'll go through another pass once we're done animations stuff this time and get concept art
characters in the next full round" ... then: "I meant for it to select ones for those we haven't
animated yet".

- **This round:** every character NOT yet animated gets a critic-picked concept-art design first
  (`CRITIC.md`: aesthetic priority, any lore-sensible character that can fill the gameplay role), then
  its walk. That's bellwether, mireclaw-alpha, gloom-lurker, carapace-brute, spore-mortar, derelict-bot,
  gloam-hound, bog-mender, spore-drone, brood-sac, hive-spire, bog-mutant (pod-carrier). The critic
  delivers picks in that order, a few at a time. Route: concept -> Qwen-Image-Edit to a clean
  full-body 3/4 pixel-art front on white (4 seeds, checked at 96 px after the palette lock) -> the
  normal video route. Aaron sees each design sheet as it lands; it proceeds unless he vetoes.
  Characters whose body can't loop cleanly (many legs, hover, pulse): one take per direction, least-bad
  loop, rule-11 seam exception.
- **Next pass:** the characters already animated (mycologist, vine-ranger, drowned-diver, blast-diver,
  frog-settler, mireclaw-stalker, sporeling-mite, cinder-husk) get the same concept-art treatment.

**10:55 update (Aaron):** the v2 concept picks are rejected ("It needs to focus more on pixel art and
how thin some of those would be"). The critic re-picks under the pixel-art / thickness-first CRITIC.md.
**Keep, never redesign:** frog-settler, sporeling-mite, mycologist.



**16:1x (Aaron, rule 13):** real locomotion for every mover. Speeds (npcs.ts): lurker 4.6 (fastest),
sporeling 4.4, stalker 4.2, gloamhound 4.2, warden/spore-drone 4.0, pod/brood-sac 3.0 once woken,
hivespire 0 (only stationary one). Gloom-lurker: prowl, not pulse. Brood-sac: needs a real way to move
(hatch legs / crawl / roll) or a design that can. Spore-drone: real flight (wing beats/thrust), not a bob.


## Resume 2026-11-04 (Aaron: "go down the list for the remaining characters")

The run stopped 09-29 ~20:20. Merged main at 0b3f6c3f. Census: `/mnt/d/tmp/cast-walks/census-2026-11-04.tsv`, per-ref detail `census-2026-11-04-refs.tsv`.
This section supersedes every status above. Rules unchanged. Gate head is still G7 `938319cdcc807028`.

On main (5): vine-ranger, mycologist, drowned-diver, blast-diver, frog-settler.

In flight, finish first:
1. sporeling-mite: Wan ne/n from the kf2 picks (ne s3, n s3), then gate. Its ne-idle fails charConsistency (height 43 vs 46), which keeps this branch red, so nothing merges to main until it lands.
2. cinder-husk: gate wip/cinder-finish-art (cut off 09-29), ship for testing (Aaron 09-29: "fine for now"), redesign later.
3. bellwether: take1 s/se/e pass; retake ne (1.563) and se per queue-retakes.sh, assemble, gate.
4. mireclaw-stalker: not asking for exception G8 yet. Case: /mnt/d/tmp/cast-walks/gate-case-stalker-2026-11-04.md. The exception alone would not ship it (gates 4a and 5 stay red, wrong-facing idles are fixed only in uncommitted ship5 edits), and rule 14 wants a better route tried first. Running the skeleton-control se A/B Aaron queued on 09-29.

Not animated, in order, using concept-picks-v3 and rule 13:
5. gloom-lurker, 6. mireclaw-alpha (needs a brief), 7. carapace-brute (needs a brief), 8. spore-mortar, 9. derelict-bot, 10. gloam-hound, 11. bog-mender, 12. spore-drone, 13. brood-sac, 14. hive-spire, 15. bog-mutant (redesign, Aaron veto).

Junk, never merge: wip/mireclaw-alpha-crash-0929 (files zeroed by a crash).

Concurrency: each worker has its own worktree and branch `art/<char>-1104`, cut from origin/art/cast-walk-cycles. Workers append to PROGRESS.md through the /mnt/d/tmp/cast-walks symlink and do not commit it; the coordinator commits it. Workers stop at "ready" for the coordinator's contact-sheet check (rule 5); merges are serial.

## Resume 2026-11-06 06:3x (Aaron: "resume the sprite art for the rest of the cast, then improve props; loop through art improvements overnight, ComfyUI as the pacing signal")

Supersedes the order above. Crash 00:30 11-06 (4th since 11-04). Gate head still G7 `938319cdcc807028`.

In flight (workers, sharing GPU-WAN.lock):
1. bog-mutant: Aaron picked A pod-carrier s3 (00:08). Walk: take1 se/e/ne/n pass, s retake. Branch art/bog-mutant-1105.
2. derelict-bot: gate 9/9 at 76bcd63c; shipping checks + se gauge pocket fix. Branch art/derelict-bot-1105.
3. bog-mender: Step 0 design (proceeds unless vetoed), then walk. Branch art/bog-mender-1106.

Next, in order: 4. mireclaw-alpha (original design, many-legs rig route), 5. spore-drone (real wing-beat flight, rule 13), 6. brood-sac (needs a way to move), 7. hive-spire (stationary).
Waiting on Aaron (one question each, in the morning): spore-mortar ship-or-redesign; stalker n gate-4a exemption; gloam-hound head_h gate case.
After the cast: props pass (docs/prop-sweep), then whole-game art improvement loop.
