# gloam-hound Step 0 (2026-11-05)

- **Concept**: `sporefall-art/assets/identity/lore/solder-mite.png` (sha256 `e1cb19b9…`), the critic's v3 pick: already pixel art, a hunched big-eyed critter in burnt orange with teal ribs.
- **Round 1**: `concept_to_input.py`, 4 seeds. Qwen kept the concept's stick forelegs and spindly toes: 2.8% of the 96 px silhouette sits outside every 4x4 opaque square, run p10 3 px.
- **Paint-over**: thick rust-orange forelegs with a bent elbow and blunt rounded paws painted as crude colour blocks over round 1's seed 3 (`/mnt/d/tmp/cast-walks/gloam-hound/tools/paint.py`).
- **Round 2**: the paint-over through `concept_to_input.py`, 4 seeds. All four are 0.9-1.1% outside 4x4 (frog-settler 2.1%, carapace-brute 1.3%), run p10 5-6 px, `thin` 0.4-0.5%.
- **Pick**: seed 1004. It has a clean orange dome head, and the eye is the only one of the four that reads as an eye on the floor and not a hole. The teal ribcage is the one hot accent. 96 px, 89x92, 27 colours, all in the locked 34. Input anchor sha256 `1a74e8b3fa7c8c7c…`.
- **Lore**: family B fauna. It is a pack hunter that rings its prey and swallows essence bubbles whole, and the swallowed glow shows through its teal ribs. Not in any other swamp: a bald dome head with two huge black eyes over lit ribs, on a low four-legged crouch. It holds nothing.
- **Design sheet**: https://2cb.pw/design-sheet-1105-42911b. Rule 6: proceed to Wan unless vetoed.
