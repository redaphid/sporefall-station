# Cast walk run: handoff, 2026-11-06 11:00 MST (overnight run 06:35-11:35)

**Read first if resuming.** Decision trail: `/mnt/d/tmp/cast-walks/.audit/overnight-1106.tsv`. Board: https://draw.hypnodroid.com/b/sporefall-overnight-1106 (status cards, montage history, PROGRESS tail; `/mnt/d/tmp/cast-walks/dashboard/push_dash.py` refreshes it).

## Ready to ship (Aaron pushes; the classifier blocks main pushes from sessions)

Both fast-forward from origin/main 8ecfd465, merge-trap checked on the combination, gate hash G7 938319cdcc807028 unchanged:
1. `git push origin f91170d8:main`: ship/batch-1106b = derelict-bot walk, bog-mutant (pod-carrier) walk, hive-spire idle, 8 regenerated props, hand-sized held weapons + beasts' natural weapons, levelgen timing-test flake fix. 5521 tests pass.
2. then `git push origin ee613512:main`: ship/actions-1106 = the above + action engine (one state table; drawn draw/fidget; full attack/hurt/death clips; lob/hive event starts; pistol carriers wait 16 ticks before the first shot) + drowner pistol draw (5 dirs) + hive-spire attack clip. 5710 tests pass.
3. optional, then `git push origin aa5ae38e:main`: art/drowner-hurt-1106 = drowner hurt clip (s/e/ne/n; se falls back), fast-forwards from ee613512. 5733 tests pass.
After each push: watch deploy-web, check /ota/version.json and one frame's sha on the live site (rule 5).

## Questions for Aaron (one at a time)

1. spore-mortar: gate 9/9 on branch art/spore-mortar-1105; ship or redesign?
2. mireclaw-stalker and mireclaw-alpha (art/mireclaw-alpha-1106 b3ffb103): symmetric backs fail 4a on n. Exempt n? Cases: /mnt/d/tmp/cast-walks/gate-case-stalker-n-2026-11-05.md, gate-case-alpha-n-2026-11-06.md
3. gloam-hound head_h gate change (the hound scratch fidget, art/action-clips-1106-hound 7e2217c8, ships with it)
4. consistency check judges action frames against the idle silhouette: judge actions as a family?
5. spore-drone (art/spore-drone-1106 d7733d36, canvas fan wings): gate-5 head window is the wing tips on a flyer. /mnt/d/tmp/cast-walks/gate-case-spore-drone-head-drift-2026-11-06.md
6. bog-mender (art/bog-mender-1106 f0f6c677, medbay automaton): 1/50 front frame read side/away. docs/cast-walks/gate-cases/bog-mender-4a-s-facing.md on its branch
7. brood-sac (art/brood-sac-1106 4d59c686, root-walker egg): 4a "not a figure" 39/50
8. gate hole: verify.py exits 0 when a kind has no jobs (only the boss was affected; data fixed cafa1769). /mnt/d/tmp/cast-walks/gate-case-verify-fail-open-2026-11-06.md
Also: hound "fangs" keep the knife's durability (wear out after 20 bites) to keep fights byte-identical; removing it is a balance call.

## Infra

Hard crashes 11-06 00:30 and 10:12 (5 since 11-04). The 10:12 one happened with mindmeld stood down. A GPU power cap was tried earlier and did not help. Watchdog now auto-releases a lock only after 3 min idle; batches hold the lock between directions.

---

## Previous handoff (2026-11-05 23:40 PT)


The run animates the whole Sporefall cast with 5-direction walk cycles. Aaron paused it on 11-05 to free his GPU.
Read `PROTOCOL.md` first for the rules. This file says where things stand and how to resume.

## Live on main

`main` is 5f801b3f, live build 1075. These characters walk in 5 directions. Each was checked from the live site by frame sha256.

| character | archetype(s) | shipped in |
|---|---|---|
| vine-ranger | player | before 11-04 |
| frog-settler | civilian, shopkeeper | before 11-04 |
| mycologist | scientist | before 11-04 |
| drowned-diver | drowner | before 11-04 |
| blast-diver | breacher | before 11-04 |
| cinder-husk | cinder | eb3de96f, build 1041 |
| bellwether | bellwether | f1a750c8, build 1058 |
| sporeling-mite | sporeling | d58abc99, build 1067 |
| gloom-lurker (teal hazmat) | lurker | 5f801b3f, build 1075. Aaron rejected the design; bubble-back replaces it |

## Shipped 11-06 (Aaron: "Ship whatever you think I'll like")

`ship/batch-1105` at c4b5352c, pushed to main on 11-06, holds both of these. It fast-forwards from main. Build, lint and vitest (5395/5395) pass.

- **gloom-lurker as bubble-back**, Aaron's pick: a six-legged beetle with green essence bubbles heaped on its back. Gate 9/9 on G7. It also changes `src/render/motion.ts` so the lurker strides instead of hovering (7abbb33c).
- **carapace-brute**, existing design: a quadruped trot. Gate 9/9 on G7. It also includes a tool fix that keys out white leg-gap pockets in the leg band (`spritesheet.py`, bc7211cc, 378ed3c6).

The auto-mode classifier blocks pushes to main that carry code. Aaron gives the go, or runs `git push origin c4b5352c:main` himself.
After a push: watch `deploy-web`, then check `/ota/version.json` and one frame's sha256 on the live site against the commit.

## Waiting on Aaron's decision

| character | state | branch | question |
|---|---|---|---|
| spore-mortar | gate 9/9 | art/spore-mortar-1105 1fdb4a62 | Ship, or redesign? It reads as a nude grey alien with a crouched shuffle, the look Aaron rejected on the lurker. |
| mireclaw-stalker | 8/9, fails gate 4a on n | art/stalker-skeleton-1104 5f36bc79 (take 1 at 143b3f2a) | Exempt n from 4a? Case: `/mnt/d/tmp/cast-walks/gate-case-stalker-n-2026-11-05.md` |
| gloam-hound | 8/9, fails gate 3 head_h on s | art/gloam-hound-1105 ab75be99 | Approve the head_h gate change? Case: `docs/cast-walks/gate-cases/gloam-hound-head-h.md` on that branch. Aaron likes this design. |
| bog-mutant | shortlist only, no GPU work done | art/bog-mutant-1105 (= main) | Aaron: "needs a complete replacement and makeover", Hulk-like. Shortlist in `/mnt/d/tmp/cast-walks/bog-mutant/redesign-1105/shortlist.txt`: A pod-carrier (hooded quilted parka, glowing pods out of the back; never rendered on 09-29), B jar-head acolyte (head sealed in a glowing essence jar), C bloat-purser or the-seal-one. Next: concept_to_input seeds 3/11/23 per pick (`gloom-lurker/redesign/gpu2.sh` is the template), then a 3-candidate sheet (gloom-lurker `designsheet.py`) for his pick. |

## Not started or stopped

- **derelict-bot:** gate 8/9 on G7, branch `art/derelict-bot-1105` 45fe4d51 (frames 7f2c099e, ungated). All 5 directions are skeleton Fun-Control (seams .111-.216). Gate 4a reads n-walk-2/4/6 as facing the viewer: the square battery pack centred on the box back reads as a face panel. Next: edit the n keyframe so the back cue sits off-centre, skeleton try 2 on n, then gate once (commands in its last PROGRESS line). Known defect: in se the white gauge face keys out as a dark hole. Design sheet https://2cb.pw/design-sheet-398359.
- **mireclaw-alpha:** Aaron rejected the new design (art/mireclaw-alpha-1105) as "much worse". Keep the original. It has no walk yet; use the many-legs route.
- **Not started:** bog-mender, spore-drone (flyer), brood-sac (pod, needs a way to move), hive-spire (stationary).

## What works (measured this run)

- **Skeleton Fun-Control:** a stick-skeleton control from a periodic rig (`scripts/assets/rotoscope/`) fixes seams and boil wherever Wan I2V can't loop. It shipped or passed for bellwether ne, sporeling ne, bubble-back, carapace-brute and spore-mortar. There are rigs for biped, quadruped (`rig_quadruped.py`, with a front mode) and hexapod (`rig_hexapod.py`).
- **Dense depth control:** loses the head. Aaron vetoed that look.
- **Non-biped and action animation plan:** `docs/cast-walks/PIPELINE-NONBIPED.md` on `docs/pipeline-nonbiped-1105`. The proof is a carapace-brute trot.
- **Gate 4a:** misreads symmetric many-legged rear views. Put a rear mark inside the silhouette, not as new mass.

## Traps

- **Merge trap:** main contains bf712662, a revert of an old sporeling export. A plain merge can silently drop another character's frames and manifest keys with no conflict. After every merge, check that other characters' frames and both manifests are byte-identical to main, and count 50 `char.<archetype>.*` keys per walked character.
- **Crashes:** the machine hard-crashed 3 times in about 5 hours of GPU work (11-04 16:35 and 18:32, 11-05 17:27). After a crash, follow PROTOCOL "After a crash". Crashes zero uncommitted files and put NUL bytes in PROGRESS.md.
- **Unexplained GPU load:** an unidentified process keeps the GPU at 40-88% and about 300 W even with ComfyUI and Ollama down. It also holds mindmeld's semantic search off.
- **`cast_walk.py sheet` writes a fixed path** and overwrote the previous sheet. Copy sheets aside before re-running.
- **Classifier:** subagents can't push to main. The coordinator pushes after Aaron's go. Writing standing authorisations into PROTOCOL.md was also refused.

## Resume

1. Restart ComfyUI and the private Ollama (RUNBOOK Environment). Delete stale `/mnt/d/tmp/cast-walks/GPU-WAN.lock`.
2. Ask Aaron the four decisions above, one at a time.
3. One fresh worker per character, each on its own branch from origin/main, sharing GPU-WAN.lock. Gates stay frozen (rule 14).
