# Cast ship gate: the change ledger

Every version of the cast ship gate (`scripts/assets/cast_walk.py gate`) that
has existed since 2026-09-29 00:59 has one entry here. The gate's version is a
hash, printed by `python3 scripts/assets/gate_hash.py`. The hash covers
exactly the content that decides PASS or FAIL. `gate_hash.py`'s docstring
lists that content. Comments, docstrings and whitespace do not change the
hash. Numbers, prompts, models and logic do.

The last entry must carry the current hash. Otherwise `cast_walk.py gate`
refuses to run, and `src/render/castGateLedger.test.ts` fails, and with it the
`pnpm exec vitest run` that gates every merge to `main`.

Aaron, 2026-09-29, after the gate was redefined seven times in one night to
pass our own art: "find a way to prevent gate bypassing like this. If we have
to change them, it should be deliberate and reasoned."

## Status at a glance

| entry | commit | gate hash | what | approved |
|---|---|---|---|---|
| G0 | c0c1e77 | `052480d04b13414c` | baseline: the gate before the night's changes | n seam 1.0 only (Aaron) |
| G1 | 6f7136e | `473e7a55207c4b2f` | silhouette: width and head judged only within the reference's own view | **pending** |
| G2 | b981cbb | `01d7ed55acc6a6c2` | 4a view votes, gate 5 boil for flicker and head_drift .08 to .14, gate 6 style prompt, new 6b | **pending** |
| G3 | 1272b21 | `a7e1608cd8cf3716` | VLM model to qwen3-vl:8b-instruct, 3 votes to 1 | **pending** |
| G4 | e78be05 | `0fda1db8022bf139` | seam for hover/pulse clips measured on a first=last-frame clip | **pending** |
| G5 | fed84b6 | `1a69448ed28e6851` | silhouette: side-view mass and centroid from the character's own walk | **pending** |
| G6 | 7046bba | `56b36ff7e776c832` | 4b same: a back view no longer answers for front-only features | **pending** |
| G7 | this ledger | `62a925f42e9ecfdc` | the guard itself; judge thresholds pinned in-repo; no number moved | **pending** |

Pending means nobody asked Aaron before the change landed. Each pending entry
is his to approve or revert. To approve, replace its `Approved-by` with his
words and the date. To revert, restore the old rule and add a new entry
recording the revert. Pending entries do not block the gate today. From G8 on,
`gate_hash.py --check` refuses an entry whose `Approved-by` does not quote
Aaron.

## Rules

1. **Workers never change a gate.** A worker whose art fails a gate reports the
   failing gate, numbers and frames to the coordinator and stops that
   direction. "The gate is wrong" is a finding to report with evidence. It is
   not a fix to apply.
2. **A gate change needs evidence that the old rule was wrong, from art the old
   rule misjudged.** "Our new character fails it" is not evidence. Approved art
   that the old rule fails is evidence (Aaron approved the frog on 09-25), and
   so is a rule that measures something other than what it claims.
3. **Aaron approves it first.** The entry quotes him with a date.
4. **An exception covers exactly one kind.** Aaron accepted the stalker's loop
   ("Let's use what we have for now"). That does not extend to "every
   non-biped". An exception entry names that kind in `Kind`.
   `gate_hash.py --check` fails a `seam_exception` for a kind with no entry.
5. **Every ship names its gate.** `cast_walk.py gate` writes `gate_hash` and
   `gate_entry` into gate.json. The CURATION.md entry for the ship cites it
   (`gate 56b36ff7e776c832`), and `--check` fails a CURATION citation of a hash
   that has no entry here.

## Adding an entry

1. Change the gate on a branch and run the old gate and the new one on the
   whole shipped cast and on the negative controls (`cast_gate_selftest.py`,
   `consistency_selftest.py`).
2. `python3 scripts/assets/gate_hash.py` prints the new hash. `--parts` shows
   which component moved, and `--rev <commit>` hashes any commit.
3. Append `## G<next>` with every field below, get Aaron's approval, quote it,
   and commit the entry and the gate change together.

Fields (all required; `gate_hash.py --check` parses them): `Hash`, `Commit`,
`Kind` (`all`, or exactly one kind), `Changed`, `Why the old rule was wrong`,
`Old gate vs new on the shipped cast`, `Negative controls`, `Approved-by`.

Numbers below marked "measured for this ledger" were run on 2026-09-29 by
`gate_hash.py --rev` and by running each revision's `consistency.py` and
tolerances against today's shipped packs. Numbers marked "per the commit" are
the commit message's own report and were not re-run: the VLM and judge gates
need the GPU, which stays on the cast.

## G0 · 2026-09-29 00:59 · baseline

- Hash: `052480d04b13414c`
- Commit: c0c1e77
- Kind: all
- Changed: Nothing new. This is the gate as it stood before the night's redefinitions. It is the first gate (6d6f3ce, 00:30) plus Aaron's n seam limit (4addfe4, 00:46: `seam_max_dir.n` 1.0, every other direction 0.5) plus c0c1e77 (verify.py `num_predict` 256 to 1536, so the thinking qwen3-vl:8b could answer at all). The frog-settler's silhouette tolerances were already widened to width 7 and head 6, and the vine-ranger's to head 15, cx 1.7 and mass .23. Both predate this ledger.
- Why the old rule was wrong: n seam: the mycologist's back view failed 0.5 on three takes (.791, .559, .91), and Aaron chose to allow 1.0 for n. num_predict: at 256 every qwen3-vl reply was cut off before its JSON, so 13 of 50 frames and every --same/--style check failed with "no VLM answer". That was a measurement failure, not a verdict on the art (per the commit).
- Old gate vs new on the shipped cast: Silhouette gate (measured for this ledger, today's packs): 33 violations: blast-diver 7, drowned-diver 8, mycologist 7, sporeling-mite 4, vine-ranger 7. Frog 0 (on its widened tolerances).
- Negative controls: None recorded for this state.
- Approved-by: none (baseline; the n seam limit 1.0 is Aaron's decision of 2026-09-29, recorded in cast-gate-spec.json as "Aaron's decision, 2026-09-29: n (the back view) gets 1.0"; his own words are not in the repo)

## G1 · 2026-09-29 02:26 · silhouette is view-aware

- Hash: `473e7a55207c4b2f`
- Commit: 6f7136e
- Kind: all
- Changed: consistency.py. For a walk character, `step` is judged with the walk family. Width and head block (VIEW_DEPENDENT) are compared only on frames drawn from the reference's own direction. Height, mass, centroid and foot line still gate every pose frame. The frog's tolerances go back to the defaults (width 3, head 2).
- Why the old rule was wrong: The gate compared every direction's idle to the front s-idle at width ±3 and head ±2. A profile is narrower than a front view, and a pack joins the head rows from the side, so any character with drawn side views fails on good art. The evidence: the frog (approved 09-25) passed only because its tolerances had been widened to ±7/±6 by hand.
- Old gate vs new on the shipped cast: Silhouette (measured for this ledger): 33 violations to 5 (drowned-diver e-idle mass .24, sporeling-mite e-idle mass .24 and ne-idle height 3, vine-ranger e-idle cx 2.33 and mass .34). The frog passes on the default tolerances instead of its widened ones.
- Negative controls: consistency_selftest.py, 9 cases that must fail: height, bulk, foot line, centroid, same-view width, a slimmer walk build. The pre-change code fails 2 of the 9 and the new code none (per the commit).
- Approved-by: none (retroactive, pending Aaron)

## G2 · 2026-09-29 03:58 · gates 4a, 5 and 6 re-measured; gate 6b added

- Hash: `01d7ed55acc6a6c2`
- Commit: b981cbb
- Kind: all
- Changed: Four rules in one commit. 4a asks front/back/side against the character's own s-idle and n-idle (VIEWS_OK per direction) instead of "which way does it face" alone. Gate 5 replaces the judge's flicker (max 5) with boil (max 0.3) and raises head_drift from 0.08 to 0.14. Gate 6's style prompt judges rendering only, not colour. New gate 6b: every opaque pixel on the locked 34 colours (off_max 0). num_predict goes to 4096 behind one `_generate()` helper.
- Why the old rule was wrong: Gate 5: the judge's GATES were calibrated on a Blender mannequin and 40 fps boil clips. On 16 fps Wan walks, the approved frog's shipped loops fail them (flicker 11.7-19.2 against 5, head_drift .066-.134 against .08). Flicker also cannot see boil there: heavy synthetic boil moved the mycologist's e from 22.3 to 24.3. 4a: a sealed visor gives one image nothing to read, so the model keyed on the backpack (mycologist e, 6 of 10 frames read "away"). 6: the prompt described the palette as "dark teal/olive" and failed a cream suit drawn entirely in the locked colours. All per the commit. Reviewer's note: the new head_drift 0.14 is the frog's worst loop (.134) plus margin. It is calibrated to pass the approved character, not derived from what head drift a viewer notices.
- Old gate vs new on the shipped cast: Per the commit. Mycologist: 4a e 4/10 to 10/10, gate 5 FAIL to boil .108-.173 and head .070-.121, gate 6 8 FAIL/10 to pass. Frog: 4a e 10/10, gate 5 FAIL to boil .103-.282. The rest of the shipped cast was not run on the old gate.
- Negative controls: cast_gate_selftest.py (per the commit): 4a 27/27, with the front submitted as e, n and ne and the back as e and s all FAIL. Gate 5: the judge's rejected boil clips at 16 fps FAIL (muck_slog .356, net_cast .308, run .443), and so does the frog's e with seeded boil (.317). Gate 6: a blurred mycologist sprite and a painted 3D render FAIL. 6b: a channel-rotated frame FAILs (off-palette 1.0).
- Approved-by: none (retroactive, pending Aaron)

## G3 · 2026-09-29 04:25 · the VLM runs on the instruct model, one vote

- Hash: `a7e1608cd8cf3716`
- Commit: 1272b21
- Kind: all
- Changed: verify.py. Default model `qwen3-vl:8b` to `qwen3-vl:8b-instruct`, VOTES 3 to 1, num_predict 4096 to 512.
- Why the old rule was wrong: It was not wrong. It was slow. The thinking model thinks 140-1500 tokens per call, and one gate took about 60 min (per the commit). This is a speed change that also changed what the gate catches.
- Old gate vs new on the shipped cast: Per the commit: mycologist re-gate 9/9 PASS in 194 s on instruct. Known loss: the instruct model passes a blurred mycologist sprite as pixel art, and the thinking model caught it. The same commit changed the selftest so a gate 6 negative counts as caught by "6 or 6b". The blurred sprite is caught only by the palette gate (98.7% off the locked 34). A blurred sprite that stays on the palette is not caught by any gate.
- Negative controls: cast_gate_selftest.py, 0 wrong in 169 s on instruct (per the commit), after the gate 6 control was redefined as above.
- Approved-by: none (retroactive, pending Aaron)

## G4 · 2026-09-29 05:29 · hover and pulse clips loop on their first frame

- Hash: `0fda1db8022bf139`
- Commit: e78be05
- Kind: all
- Changed: spritesheet.py adds `closed_loop`. For a hover or pulse clip, generated by Wan's first-last-frame node with the keyframe at both ends, gate 1's seam is frame 0 against the last frame, and the whole clip is the loop.
- Why the old rule was wrong: find_loop found no loop point under 0.5 in hover clips, whose limbs swing on their own (spore-drone, PROGRESS.md 05:11). Reviewer's note (inference, not measured): a first-last-frame clip is conditioned to end on its first frame, so this seam measures the conditioning more than the motion. Rule 13 (Aaron, 16:1x: "I'm concerned you are reward hacking") later ruled that a hover or bob loop is not a walk.
- Old gate vs new on the shipped cast: No shipped character uses it. The one closed-loop run on disk is spore-drone take5-flf, which is parked and not exported.
- Negative controls: spritesheet_selftest.py 150/150 (per the commit). No control shows a closed clip that fails to come home failing gate 1.
- Approved-by: none (retroactive, pending Aaron)

## G5 · 2026-09-29 07:14 · side-view poses answer to their own walk

- Hash: `1a69448ed28e6851`
- Commit: fed84b6
- Kind: all
- Changed: consistency.py. A walk character's side-view (e) poses take mass and centroid from the median of that view's walk frames, not from the front s-idle. Height and foot line still cross every view.
- Why the old rule was wrong: In a side view the figure's width is its depth. The redesigned player's true profile is 11 px wide against 21 px in front and carries 66% of the front's mass, so gate 3 called it a different character while gate 4 requires exactly that profile (per the commit). Reviewer's note: the reference for a side idle is now the same clip's walk. An idle and a walk that are both off-model in the same way pass. Only height and foot line still tie the side view to the front.
- Old gate vs new on the shipped cast: Silhouette (measured for this ledger): 5 violations to 1. vine-ranger e-idle (mass .34, cx 2.33) and drowned-diver e-idle (mass .24) now pass, and so does sporeling-mite e-idle (mass .24). Left: sporeling-mite ne-idle height 3 (limit 2), which fails the current gate too. Its export (e740004) is marked ungated.
- Negative controls: consistency_selftest.py 12/12 (per the commit). The new slim-profile case fails on the old code. A side idle whose bulk differs from its own walk now fails. Bulk, off-centre, height, foot-line and build controls still fail.
- Approved-by: none (retroactive, pending Aaron)

## G6 · 2026-09-29 09:28 · identity check stops asking a back view for a visor

- Hash: `56b36ff7e776c832`
- Commit: 7046bba
- Kind: all
- Changed: verify.py SAME_PROMPT (gate 4b same). A back or three-quarter-back view hides the face, visor and chest and may show a tank or pack. The model judges what both views share.
- Why the old rule was wrong: The blast-diver's front is a saturated orange visor that a back view cannot show. The prompt asked for the same outfit and colours, so every back view failed ("first image has a large orange visor"), per the commit.
- Old gate vs new on the shipped cast: Per the commit: blast-diver n-idle and n-step go from FAIL to pass. The closest wrong character fails under both prompts: drowned-diver backs against the blast-diver front, and the reverse.
- Negative controls: cast_gate_selftest.py gains 4b-same controls: five characters' own ne/n backs must pass, and sixteen cross-character backs must fail. 0 wrong (per the commit).
- Approved-by: none (retroactive, pending Aaron)

Not an entry: ce6f15a (10:07) added flow-stripping commands to cast_walk.py,
and c0226fb removed them 13 minutes later. The hash left G6 and came back to
it, and no gate rule changed.

## G7 · 2026-09-29 · the guard

- Hash: `62a925f42e9ecfdc`
- Commit: this ledger's commit on art/cast-walk-cycles
- Kind: all
- Changed: `cast_walk.py gate` refuses to run unless the gate is this ledger's head. It refuses when VLM, VOTES or NUM_PREDICT are set in the environment, since those override verify.py's model, votes and token budget. It writes gate_hash and gate_entry into gate.json. Gate 5's identity_drift, sharpness and coverage_jitter limits move from sprites.judge.GATES in the art repo into cast-gate-spec.json at the same values (0.12, 60.0, 0.1).
- Why the old rule was wrong: Nothing named the gate a character passed, so a gate could change under a ship without a trace. The judge limits lived in another repo, where an edit would move this gate with no change here, and an environment variable could swap the VLM for one ship.
- Old gate vs new on the shipped cast: No threshold moved. The pinned judge values equal sprites.judge.GATES as read on 2026-09-29 (identity_drift 0.12, sharpness_min 60.0, coverage_jitter 0.1), so every verdict is unchanged.
- Negative controls: src/render/castGateLedger.test.ts. A threshold changed with no entry fails, and adding the entry passes. A pending approval after G7 fails. A seam exception with no entry for its kind fails, and so does an entry that names two kinds. A CURATION citation of an unknown hash fails. `cast_walk.py gate` refuses a changed gate before it reads the run, and refuses a VLM override. Whitespace, comment, docstring and note-only edits keep the hash, and so do a new consistency ref and non-gate code. A prompt, tolerance, default tolerance, spec value, gate function or seam finder change moves it.
- Approved-by: none (the guard was requested by Aaron, "find a way to prevent gate bypassing like this" (2026-09-29), but he has not reviewed this version)

## Not in the gate yet

- **mireclaw-stalker seam exception** (wip/stalker-ship, 4698de0, hash
  `3f96c6d368a5060f` on that branch). It adds `seam_exception` for
  mireclaw-stalker: s 1.6, se 1.4, e 0.6, ne 1.4. The ceilings are the shipped
  loops' measured seams rounded up. Aaron accepted this character's loop:
  "Let's use what we have for now. The earlier stalker animations were pretty
  good, except for a flash near his feet, and possibly the loop." (2026-09-29
  09:3x). When it lands, it takes the next entry with `Kind: mireclaw-stalker`
  and that quote.
- **PROTOCOL.md rule 11's generalisation** (docs only, no hash). The rule said
  that any character whose body can't make a clean loop "(hover, many legs)"
  ships with a per-kind seam exception, the way Aaron accepted the stalker's.
  Aaron approved one character. Rule 13 ("I'm concerned you are reward
  hacking") came after it. The coordinator withdrew the generalisation in
  5efe013. Exceptions now come one kind at a time, through this ledger.

## Outside the hash

The hash cannot see these. A reviewer checks them by hand.

- The judge's metric code (`sprites/judge.py` in the art repo: identity_drift,
  head_drift, sharpness and coverage_jitter as measured). Its thresholds are
  pinned here since G7. Its measurement is not.
- `generate.py`'s job table, which verify.py reads for each frame's direction
  and category.
- A run's `sheet.json`: gate 1 reads the seam from it. Editing it by hand
  forges gate 1.
