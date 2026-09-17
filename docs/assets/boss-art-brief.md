# Art brief — the Sporefall Station bosses

Covers all four registered bosses (`src/game/data/bosses.ts`): the **Mireclaw Alpha**
(`boss`), **The Vigil** (`vigil`), **Subject Echo** (`echo`) and **The Sealkeeper**
(`sealkeeper`).

**Status:**

| Boss | Art |
|---|---|
| Mireclaw Alpha (`boss`) | **COMPLETE** (2026-08-20) — violet armoured crab, shipped in both packs |
| The Vigil (`vigil`) | **IN GENERATION** — draws as a procedural blob until it lands |
| Subject Echo (`echo`) | **IN GENERATION** — same |
| The Sealkeeper (`sealkeeper`) | **IN GENERATION** — same |

The **game-side install path for all three is already built and tested** — see
"Landing the art" at the bottom. Nothing in the engine, the manifests or the scripts is
waiting on a decision; only the PNGs are outstanding.

**The custom-node blocker previously recorded here was STALE and has been struck.**
`comfyui_ipadapter_plus`, `rembg-comfyui-node` and `comfy-mtb` were installed
2026-08-08 and verified live on 2026-08-20 against ComfyUI's 942 registered nodes
(IPAdapter 28, rembg 2, mtb 80). **No owner approval is required.** The referenced
`_mycel-results/assets.md` is not in this repository.

## Why it is needed

`boss` had no art of its own: `art.CHARSET_ALIAS` mapped it to `thug`, so the Mireclaw
Alpha was **pixel-identical to the commonest enemy in the game** — same body, same
palette, same size. That is the single largest reason the owner cleared roughly six boss
floors and reported never having met a boss.

That failure is why this document exists, and **it is now three times as easy to
repeat**: the Vigil, Echo and the Sealkeeper each ship with no `char.*` art at all, so
scale and colour are carrying their entire silhouette. Everything that can be fixed
*without* art has been, for every boss:

- a `bossReveal` entrance card and a pinned health bar with a per-boss phase read-out
  (`ui/bossModel.ts`), driven off the `BOSSES` registry rather than hardcoded;
- a distinct `ARCHETYPE_SCALE` entry per boss, pinned by `render/bossArt.test.ts` so a
  new boss cannot inherit the silent `?? 1` thug-size default;
- a distinct `ENTITY_COLORS` entry per boss, pinned by the same test so none of them
  draws as the generic `0xcccccc` grey eyeball, shares a colour with another boss, or
  shares the thug's.

The silhouette is the last piece, and the only one art can supply.

## The seam is already open — no code change is needed to land a sprite

Three things are true in this branch today, so an art pass is pure asset work:

1. **All four archetypes are in `theme.CHAR_NAMES`**, so `char.<arch>.*` is a
   **canonical manifest key**. This is the load-bearing, invisible one: a `char.*` key
   whose character is not in `CHAR_NAMES` is not canonical, so `validateManifest`
   **drops the mapping with a warning** and the PNG is silently discarded however
   correct the file is. `boss` needed exactly this before the Alpha could load;
   `vigil`/`echo`/`sealkeeper` were added ahead of their art for the same reason.
2. **`art.characterSet` prefers an archetype's OWN set** over the one it borrows
   (`sprites.chars[archetype] ?? sprites.chars[alias] ?? procedural`). Drop the files
   in, map them in the manifest, and the boss promotes off its fallback automatically.
3. **`scripts/assets/install_boss_art.py` does the whole install** — both packs, both
   manifests, the lineage row and the silhouette spec — in one idempotent, dry-runnable
   command.

Leave `CHARSET_ALIAS.boss = 'thug'` in place as the Alpha's fallback, and leave
`vigil`/`echo`/`sealkeeper` mapped to **themselves**. Membership of that map is what
`isCharacterSprite()` tests; an archetype missing from it falls past the character path
entirely and draws as the generic procedural blob.

## Spec — identical for every boss

| | |
|---|---|
| Manifest keys | `char.<arch>.<dir>-idle` and `char.<arch>.<dir>-step`, `dir` ∈ `s, se, e, ne, n` (10 keys) |
| Frames to author | **`s-idle` and `s-step` only.** The other four directions borrow the `s` art, which is what every non-player NPC does |
| Canvas | 48×48 logical, **feet-anchored** (feet on the bottom edge, horizontally centred) |
| `swampspace` (base) | 48×48, posted at 46px content — lands a ~44px content bbox |
| `swampspace-hires` | 96×96, posted at 92px content — lands a ~90px content bbox. That pack declares `artScale: 2` |
| West half | mirrored from the east half at runtime; do **not** author `w`/`sw`/`nw` |
| Optional | the `char.<arch>.<dir>-<state>-<n>` state grammar (walk/attack/death) if the pipeline gets that far |

**Both packs must be updated: `swampspace-hires` does not `extend` the base pack**, it
carries its own full sprite table, and it is the pack the game defaults to. Art written
to the base pack only is art the player never sees — that shipped once, nine sprites
deep, with every check green (`render/themePackParity.test.ts` exists to catch it now).

The two content figures above are measured off the shipped Alpha, not guessed:
`generate.py final` posts characters at `content = px - 2` and `hires_chars.py` at
96/92, and `post.kcentroid` then drops a mostly-transparent edge column each side.

## The roster, and the art direction already settled in code

These numbers are **not proposals** — they are what `src/render/art.ts` ships today, and
`bossArt.test.ts` pins them. Author art to match them, not to replace them.

| archetype | name | colour | `ARCHETYPE_SCALE` | silhouette |
|---|---|---|---|---|
| `boss` | Mireclaw Alpha | violet `#a05ae0` | 1.5 | low-slung armoured arthropod, clawed |
| `vigil` | The Vigil | slate-teal `#4e7d8c` | 2.25 | fused into a bulkhead, "more wall than animal" |
| `echo` | Subject Echo | acid chartreuse `#c2e04a` | 1.6 | mismatched grafted limbs, surgical harness |
| `sealkeeper` | The Sealkeeper | brass-amber `#b8863f` | 1.9 | one oversized hydraulic arm; mass IS the silhouette |

A wrinkle worth knowing before matching hues: the Alpha's violet comes from the theme
packs' `palette.entities.boss`, which **overrides** the built-in `ENTITY_COLORS.boss`
(a hot red `0xe0483f`) at runtime — `art.ts` merges `{...ENTITY_COLORS,
...palette.entities}`. The other three have no `palette.entities` row, so they use their
`ENTITY_COLORS` value directly. Violet is what the player actually sees for the Alpha.

### Mireclaw Alpha (`boss`) — done, and the lineage reference

The apex of a **named food chain** the player sees on screen: Mireclaw Brood
(`sporeling`, its summoned adds) → Mireclaw Scavenger (`stalker`) → **Mireclaw Alpha**.
It reads as the *same animal lineage* as those two, scaled up and armoured — not as a
separate monster.

- Low-slung arthropod, chitin-plated, **clawed** (the claws are its weapon and must be
  visible in the silhouette — that is what replaced the baseball bat).
- Violet chitin, spore-bloom highlights, against the thug's dusty red `#d17f7f`.
- It lives in the spore and regenerates in it (phase 2), so wisps/growth on the carapace
  are on-lore.
- **Must not** read as an upright humanoid. That was the recurring failure mode in the
  `stalker` seed sweep: 3 of the first 4 seeds drifted to upright bipeds.

### The Vigil (`vigil`) — scale 2.25, the largest thing in the game

Per `data/bosses.ts` and `systems/vigil.ts`: something enormous **fused into a reactor
bulkhead** that has not moved in years, vulnerable only while dormant. The player's verb
is BE QUIET — every loud tool wakes it, and awake it is near-immune.

- **More wall than animal.** It must look *immovable at a glance*, before the noise
  meter has taught anyone anything. At `CHAR_PX` 48 on `TILE_PX` 32, 2.25 draws ~3.4
  tiles tall: it **fills** a doorway rather than standing in one.
- **It must NOT read as an upright humanoid.** This is the hard constraint for this
  boss. A big biped is a monster you fight; a thing grown into the architecture is a
  hazard you creep around, and the whole fight is built on the second reading.
- 2.25 is 1.5 applied twice — one more rung up the *same* ladder the Alpha climbed over
  the thug, rather than a second sizing scheme nobody else obeys.

### Subject Echo (`echo`) — scale 1.6, a person-shaped thing that was added to

A **lab subject that kept adapting** (`systems/echo.ts` mutates its per-damage-kind
resistance at runtime). The player's verb is NEVER HIT IT THE SAME WAY TWICE.

- **Mismatched grafted limbs and a surgical harness.** The body should look assembled
  and re-assembled — the adaptation is the character, and it has to be legible while
  the thing is standing still.
- Acid chartreuse reads chemical and cultured, deliberately wrong for a bog, and is the
  maximum-distance hue from the Alpha's violet, the Vigil's teal and the civilian tan.
- 1.6 is barely over the Alpha and well under the Vigil, and the gap is the point: Echo
  is a lab subject that kept adapting, not a thing grown monstrous. It reads as a
  **person-shaped body that has been added to** — something that was once on a gurney.

### The Sealkeeper (`sealkeeper`) — scale 1.9, hardware that outlived its crew

A **maintenance unit built to shut bulkheads**, now sealing the wing behind it
(`systems/sealkeeper.ts`). The player's verb is DEMOLISH — grenades stop being a weapon
and become a tool.

- **One oversized hydraulic arm**, and **mass is the whole silhouette**. It must read as
  able to shove a hatch shut on you, because that is the one thing the fight is about.
- Oxidised brass-amber: bulkhead hardware, not an organism. It is the only one of the
  four that is straightforwardly a machine, and it should be unmistakable at 48px.
- 1.9 sits heavier than Echo and under the Vigil.

## Gotchas carried forward — these were paid for

- **Do NOT IPAdapter-anchor a new creature on an existing character sprite.** A
  held-seed A/B at **seed 900044** gave **0 violet pixels at every anchor weight tried,
  versus 141 unanchored** — the anchor sprites are themselves desaturated, so style
  transfer faithfully reproduces grey and recreates the same-as-the-common-enemy problem
  the anchor was meant to prevent. The roster is already mixed-base, so that consistency
  risk is overstated.
- **Run the silhouette-consistency gate on the POSTED 48px sprites, not the 1024px
  raws.** On an alpha-less raw it measures the full frame and reports a meaningless
  pass. `install_boss_art.py` derives the spec from the posted base-pack frame for this
  reason; `consistency.py --check` and `render/charConsistency.test.ts` both read the
  48px pack.
- **At 48px thin limbs alias out and dark chitin quantizes to grey.** Author a
  **thicker, heavier** silhouette than looks right at 1024, and keep the value range off
  pure black. Judge every candidate at game size, on a contact sheet — not zoomed in.
- **The locked palette has no violet or indigo RAMP** (`scripts/assets/palette.py`
  carries warm tan, teal, olive-green and neutral steel, plus single-colour accents —
  `#a05ae0` is one of those accents, not a ramp family). A ramp written in a hue the
  palette does not carry snaps to grey and lands under the cast's chroma floor. The
  bosses' identity colours are entity TINTS, not ramp families.
- Existing `stalker` raws worth mining for lineage consistency:
  `D:/tmp/swampspace-stage/char.mireclaw-stalker.s-idle/` (seed `00007` fits the brief).

## Landing the art

One command per boss, from the repo root. It is idempotent, re-runnable, dry-runnable,
and never deletes a shipped asset (anything it would overwrite is copied into
`scripts/assets/raws/archive/<pack>/` first):

```
python3 scripts/assets/install_boss_art.py <archetype> \
    --idle <s-idle raw>.png [--step <s-step raw>.png] \
    --seed <N> --ckpt <checkpoint> --note "<one line>" [--dry-run]
```

`<archetype>` is `vigil`, `echo` or `sealkeeper`. With no `--step` the step frame is
synthesized from the posted idle by `post.derive_step` — the engine alternates idle/step
while a character moves, so a boss without one reads as sliding rather than walking.

It writes, in one pass: the 96px hi-res frame, the 48px base frame, the ten
`char.<arch>.*` keys in **both** manifests, the `curation.json` lineage row (archiving
the source raw into the committed `raws/` dir), and the `consistency-spec.json`
silhouette envelope. That last one is not optional — `render/charConsistency.test.ts`
fails on any character kind present in the base pack with no committed spec.

File stems are fixed in `manifest.py BOSS_KINDS` (`the-vigil`, `subject-echo`,
`the-sealkeeper`) so the names the installer writes and the names a full manifest
regeneration looks for cannot drift apart.

Then gate it:

```
python3 scripts/assets/consistency.py --check
corepack pnpm run build && corepack pnpm exec vitest run && corepack pnpm run lint
```
