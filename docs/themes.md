# Themes — data-driven visual + flavor packs

A **theme** swaps the game's entire visual and flavor identity (sprites, palette,
entity display names) with **zero code changes and zero sim impact**. The sim
(`src/game/`) knows nothing about themes: a warden is always archetype `warden` in the
world and over the wire; a theme only changes how that warden *looks* and what the
UI *calls* it ("Bog Warden" in a swamp theme).

- Engine side: `src/render/theme.ts` (pure schema/validation/resolution),
  `src/render/themeLoader.ts` (fetch + pixi Assets baking), `src/render/themeState.ts`
  (active-theme name lookup for the UI).
- Theme packages live in `public/themes/<themeId>/` — one `manifest.json` plus
  the asset files it references.
- The current look is the default theme **`settlement`** (`public/themes/settlement/manifest.json`),
  which points at the legacy `public/sprites/` files.

## Selecting a theme

| Mechanism | Behavior |
|---|---|
| Settings panel (gear icon) | Persisted to localStorage (`sporefall.settings`, field `theme`). |
| `?theme=<id>` URL param | Dev override for this session only; does **not** persist. |
| Debug verb `theme <id>` | Runtime hot-swap via the debug channel / MCP / `window.__verb`. |
| `window.__setTheme(id)` (under `?e2e`) | Returns a promise that resolves when the swap finishes — for tests. |

Theme choice is **local presentation**. Net play never negotiates it; peers may
render the same world with different themes. Flavor names shown in net-visible UI
(the tap-inspect card) are resolved *per device from that device's theme* —
nothing themed ever crosses the wire.

The settings panel lists themes from `public/themes/index.json`:

```json
[
  { "id": "settlement", "name": "Settlement" },
  { "id": "test", "name": "Test (magenta)" }
]
```

**A new theme must add itself to this index** to appear in the picker (it is
still loadable by id without an index entry).

## Manifest schema — `public/themes/<themeId>/manifest.json`

```jsonc
{
  "name": "Sunken Bayou",        // human-readable theme name (string)
  "version": 1,                  // schema version; currently 1 (number)

  // Every field below is OPTIONAL. Anything you omit falls back (see
  // "Fallback semantics"). An empty manifest {} is valid: it renders as settlement.

  "palette": {
    "background": "#0b120b",     // canvas clear color
    "uiAccent":  "#7fd17f",      // exposed as CSS var --theme-accent on <html>
    "floorTint": "#c8ffc8",      // multiplied over the whole tile layer
    "tiles": {                   // procedural tile colors (used when a tile has
      "causeway":   "#1e2a1e",     //   no sprite); keys: the six below plus
      "boardwalk": "#2a3a2a",     //   hall grate tiled plating hull bog
      "floor":    "#3a4a2a",
      "wall":     "#101a10",
      "grass":    "#2e5d3a",
      "exit":     "#d4af37"
    },
    "entities": {                // procedural entity-blob colors, by archetype
      "warden": "#4a7a5a", "civilian": "#b0c090"
    }
  },

  "names": {                     // display names by archetype — SAME sim
    "warden": "Bog Warden",         //   behavior, themed presentation. Shown in
    "mutant": "Mire Lurker",       //   the tap-inspect card title. Any archetype
    "civilian": "Villager",      //   key is allowed.
    "door": "Root Gate"
  },

  "sprites": {                   // sprite key → file path. Paths are relative
    "tile.floor": ["tiles/floor-0.png", "tiles/floor-1.png"], // to this theme's
    "tile.wall": "/sprites/brick-wall.png", //   folder, or app-root-relative
    "tile.grass.accent": ["tiles/roots.png"], //  with a leading "/". fx.* keys
    "fx.flame": ["fx/flame-1.png", "fx/flame-2.png"], // take ARRAYS (animation
    "item.default": null         //   frames); tile.* keys take arrays too
  },                             //   (coord-hash VARIANTS + rare accents).
                                 //   `null` means "force the built-in
                                 //   procedural art" (blocks fallback to the
                                 //   default theme).

  "anim": {                      // OPTIONAL per-state animation cadence, in sim
    "walk": 6,                   //   TICKS PER FRAME (30 ticks = 1s). Integers
    "attack": 2                  //   1..30. States you omit use the engine
  },                             //   defaults (see "Animation states" below).

  "macroTiles": {                // OPTIONAL: tile surfaces whose variant pool
    "floor": 2                   //   is sliced from N×N-tile macro images
  }                              //   (N ∈ 2..4; see "Macro-tiles" below).
}
```

Colors are `#rrggbb` (7-char hex). Paths may not contain `..` or a URL scheme.
Invalid or unknown entries are **dropped with a console warning** — a bad
manifest never crashes the game, it just falls back.

### Sprite keys (the complete canonical set)

The engine bakes every sprite to its slot size — ship square PNGs of any
reasonable resolution (64–256 px); transparent background; top-down/billboard
per slot as described. Unknown keys warn and are ignored, so typos fail loud in
the console and in `validateManifest` unit tests.

| Key | What / notes |
|---|---|
| `tile.<name>` | ground/wall tile art, `<name>` ∈ `causeway boardwalk floor wall grass exit` plus the indoor-complex decks `hall grate tiled plating hull bog` (floors 3+; `hull` is wall-family). A single path OR an **array of variant paths** — the tilemap alternates variants by a deterministic per-coordinate hash, so big surfaces read as texture instead of one repeated stamp (same seed → same ground on every device). Should tile seamlessly. The wall's first variant is also clipped onto the bevelled corner-cut tiles. |
| `tile.<name>.accent` | OPTIONAL rare-detail pool for that surface (root cluster, vent grate, glowing spore patch…). One accent replaces the base variant on ~1/17 tiles, picked on the same coordinate hash. Array or single path. |
| `tile.<name>.overlay` | OPTIONAL pool of RGBA decals placed by CONTEXT, not by chance: the tilemap plans placements from the tile grid — wall bases, room corners (two adjacent walls → two overlapping decals), door thresholds, macro-cell plate seams, plus a rare open-floor clump (`src/render/tileSelect.ts` `planTileOverlays`). Author each decal with its mass biased toward the TOP edge of the tile; the renderer rotates it toward whichever edge earned it. This is how overgrowth "pools" against structure instead of being speckled into the base texture. Deterministic per coordinate — same moss on every device. |
| `tile.<name>.cap` / `tile.<name>.cap.inner` | OPTIONAL, wall family only (`wall`, `hull`). The lit top strip of the wall, authored as RGBA along the tile's TOP edge (transparent below), plus the matching cap-sized nub in the top-left corner. The tilemap lays the strip on every edge of a wall tile that faces open ground, rotated to that edge, and the nub in concave corners (`src/render/wallCaps.ts`), so the cap line runs continuously along runs, corners and T-junctions; bevelled corners bake it along the 45° cut too. When a theme ships these, its wall BODY art must carry no cap of its own (`scripts/assets/wall_caps.py` splits a baked cap off existing art). Both keys or neither. |
| `char.<name>.<dir>-<frame>` | directional billboard character, LEGACY two-frame form. `<name>` ∈ `player warden mutant civilian scientist acolyte robot`; `<dir>` ∈ `s se e ne n`; `<frame>` ∈ `idle step`. 70 keys. See "Character art convention" below. |
| `char.<name>.<dir>-<state>-<n>` | directional character ANIMATION-STATE frame. `<state>` ∈ `idle walk attack hurt roll death draw fidget aim aimwalk`; `<n>` ∈ `0..7`, contiguous from 0. Same `<name>`/`<dir>` sets as above. See "Animation states" below. |
| `unit.player`, `unit.warden` | single-sprite billboard fallback (no directions) |
| `unit.<name>.idle`, `unit.<name>.step` | single-sprite two-frame walkers, `<name>` ∈ `mutant scientist robot` |
| `item.default` | generic ground-item sprite |
| `item.<id>` | per-item pickup, `<id>` ∈ `pistol wrench knife medkit cash shotgun molotov grenade-item` |
| `prop.default` | generic prop (crates etc.) |
| `prop.<name>` | `<name>` ∈ `barrel cryo-terminal vending-machine tv toilet` |
| `projectile` | bullet base texture (small, oriented flying +x; rotated to heading). Weapon-mod visual traits (elemental tints etc.) are applied ON TOP of this texture at runtime — themes provide the base art, mods compose over it. |
| `grenade` | thrown grenade base texture (same composition rule) |
| `fx.flame` | **array** — looping fire frames (3 in settlement) |
| `fx.hit` | **array** — hit-spark clip (1 frame in settlement) |
| `fx.explosion` | **array** — explosion clip (3 frames in settlement) |
| `fx.pickup` | **array** — pickup sparkle clip |
| `fx.blood` | **array** — death splat (drawn under actors, not additive) |

### Macro-tiles (`macroTiles`, slice-coherent variant pools)

A 32px tile can't hold a feature bigger than itself, and a pool of independent
32px variants still repeats visibly on large surfaces. `macroTiles` fixes both:
author a surface as one or more **N×N-tile macro images** (N ∈ 2..4 — e.g.
64×64px for N=2), slice each macro into its N² tiles **row-major**, and list
the slices in the `tile.<name>` pool (macro 0's slices first, then macro 1's…).
Declare `"macroTiles": { "<name>": N }` and the tilemap picks each tile's
variant by **position** — quadrant `(tx mod N, ty mod N)` — so adjacent slices
always land adjacently: plate seams, ripple rings and other large features span
tiles seamlessly. Which macro fills a given N×N cell is hashed **per cell**, so
multiple macros alternate deterministically and the visible repeat period
becomes N tiles. Pools without a `macroTiles` entry keep the per-tile hash pick.
A pool whose length is not a multiple of N² ignores the trailing partial macro;
a pool shorter than N² falls back to the hash pick. Accents still replace
slices at the usual rarity — author them as self-contained feature tiles.

Archetypes that share a body keep sharing it (lockkeeper→warden, boss→mutant,
shopkeeper→civilian): theming `char.warden.*` also reskins lockkeepers. Doors, fires,
weapon-mod gems and pickup-outline shapes are procedural (themeable via
`palette.entities` colors, not sprites, in schema v1).

### Character art convention (48 px, 5 drawn directions, 8-way facing)

- **Canvas: 48×48 px** for every `char.*` and `unit.*` sprite (a global
  convention — there is no per-key size metadata). Tiles stay 32×32; characters
  deliberately overhang their tile.
- **Feet-anchored**: draw the character standing on the **bottom-center** of the
  48×48 canvas (feet touching the bottom edge, horizontally centered). The
  engine anchors there.
- **8-way facing from 5 drawn directions**: you draw `s` (toward camera), `se`,
  `e` (facing right), `ne`, `n` (away). The west half (`sw w nw`) is the east
  half **mirrored by the engine** — never draw it. Two frames per direction:
  `idle` and `step` (mid-stride); the engine alternates idle/step while moving.
- **Per-direction fallback** (a partially-drawn character is fine): a missing
  direction borrows a neighbor before giving up — `se→s`, `e→s`, `ne→e→s`,
  `n→s`; a missing `step` frame reuses that direction's `idle`. Only when a
  character has no `char.*` art at all does it fall to its `unit.*` sprite,
  then to procedural art. This is resolved per key: shipping only `s-idle` is
  a valid (if stiff) character.
- **Body motion follows the `s-idle` file name.** The art pipeline names frames
  `<kind>-<dir>-<state>.png`, and the renderer reads the kind from the file
  mapped to `char.<name>.s-idle` (`chars/spore-drone-s-idle.png` is a
  `spore-drone`). Kinds listed in `LOCOMOTION` (`src/render/motion.ts`) move
  their own way: `spore-drone` and `gloom-lurker` hover, `brood-sac` pulses,
  and `sporeling-mite` waddles (rocks side to side over its short legs, with
  the stride's lean). Any other kind or file name walks with the stride bob
  and lean. A lockkeeper or shopkeeper borrowing another body moves like it.
- **A drawn loop carries its own motion.** When a state plays a clip of 2+
  drawn frames (`…-walk-0`…), the renderer adds no procedural bob, float,
  pulse or breath on top of it. The legacy idle/step pair still gets them.
- The `settlement` theme predates this convention: its legacy 3-direction art
  (front/side/back) is mapped onto `s`/`e`/`n` in its manifest and the diagonals
  fall back per the rules above.

### Animation states (`char.<name>.<dir>-<state>-<n>`)

Characters animate through ten NAMED STATES, resolved every frame from sim
state (render-only — the sim knows nothing about animation). One table,
`ANIM_STATE_DEFS` in `src/render/animState.ts`, defines each state; the
render-side start signals live in `src/render/animTracker.ts`.

| State | Kind | Triggered by | Window |
|---|---|---|---|
| `idle` | loop | nothing else active | — |
| `walk` | loop | entity is moving | while moving |
| `attack` | one-shot | an attack/throw fired (weapon cooldown observed starting); a `lobber` firing a shell, a `hivespire` budding or spreading (sim events, drawn frames only) | its drawn clip, at least 6 ticks |
| `hurt` | one-shot | took a hit (`status.hitFlashUntil`) | its drawn clip, at least 8 ticks |
| `roll` | one-shot | dodge-roll active | the sim's roll window (12 ticks) |
| `death` | one-shot | entity died (render-side ghost; corpses leave the snapshot the same tick) | its drawn clip, at least 18 ticks |
| `draw` | one-shot, **drawn-only** | the NPC's AI entered `aggro` (it engaged a target), after at least 30 ticks not engaged | its own clip: frames × tpf |
| `fidget` | one-shot, **drawn-only** | the body has been still and calm (not aggro/flee/seek, dormant, downed, stunned, asleep or frozen) for 90 ticks; then on a per-entity grid every 180–329 ticks, hashed from the entity id | its own clip: frames × tpf |
| `aim` | loop, **drawn-only** | the body aims (below) and stands still | while it holds |
| `aimwalk` | loop, **drawn-only** | the body aims and moves, whichever way | while it holds |

**Priority when several conditions hold at once (highest wins):**
`death > roll > hurt > draw > attack > aimwalk > aim > walk > fidget > idle`.
One exception: an `attack` the pack does not draw does not cover drawn
aiming. Its stand-in (a walk or idle frame plus the held weapon at the hip)
would cut into the raised gun on every shot, so the aim frames hold and the
shot flies. A drawn attack plays over aim, then aim resumes. A pistol
carrier never has `draw` and `attack` at once: the sim holds its first shot
for the archetype's `drawTicks` (16), so an 8-frame draw at the default tpf
ends the tick the first shot fires. The order matters only when they do
overlap: a kind with no wind-up (it attacks on its engage tick), or a theme
whose `anim.draw` tpf makes the clip longer than the wind-up. Then the draw
plays whole and the attack pose is skipped; the shot itself still shows.

**Aiming (`aim`, `aimwalk`).** A body aims while it holds a ranged weapon
ready (`isAiming`, `src/game/aiming.ts`):

- an NPC whose AI is engaged (`aggro`: battle or pursuit) with a ranged weapon,
  once its engage wind-up has run (the tick its first shot may fire). So `draw`
  plays first and `aim` takes over as it ends. Fleeing, stunned, asleep, frozen
  or dormant: no aim.
- a player holding a ranged weapon, unless downed, stunned, frozen, picking a
  lock or choosing a draft card. The InputCmd carries one resolved aim vector
  (aim stick or mouse, else the move direction), so the player's gun is always
  up: the twin-stick stance.

The facing is the aim (`entity.facing`, which the sim points down the aim line
and fires along), never the move direction. A body that strafes or backpedals
keeps facing its target, and the legs play the `aimwalk` cycle whichever way
it travels. `aimwalk` runs at the theme's `walk` cadence and `aim` at its
`idle` cadence unless the manifest's `anim` names them. While either plays the
engine hides the held-weapon sprite: **the frames draw the gun**, raised and
pointing along the facing. Draw `aim` as a 1-2 frame breathing hold
(`…-aim-0`, `…-aim-1`) and `aimwalk` as 8 frames with the same stride timing as
`walk`, so the cut between them keeps the feet. The two are independent: a
pack with only `aimwalk` stands in `idle`, one with only `aim` walks in `walk`.
Without aim frames the held weapon (pack art only, see "Held weapons") stays in
the fist the body frame draws, level or at low-ready by that section's rule. Co-op clients get the
host's verdict in the snapshot (an aim trailer), so they show the same states.

**Drawn-only states (`draw`, `fidget`, `aim`, `aimwalk`).** These exist only as art. A pack that
ships no frames for one never enters it: no borrowed stand-in, no procedural
version, and the character renders exactly as it would without the state. When
the frames exist, the state lasts exactly `frames × tpf` ticks and plays every
frame once. Draw the clip so it **starts and ends on the idle pose**; the cut
in from idle/walk and back out must not jump. While `draw` plays, the engine
hides the held-weapon sprite, because the clip draws the weapon. Neither state
adds procedural motion (no breathe, lean or bob over the frames). The aim loops
move like idle and walk do: a 1-frame aim breathes, and aimwalk keeps the lean.

To enable them for a kind, map the frames in `sprites`, contiguous from 0, in
all five drawn directions (west is mirrored):

```jsonc
"char.drowner.s-draw-0": "chars/drowner/s-draw-0.png",   // … through -7, and se e ne n
"char.gloamhound.e-fidget-0": "chars/gloamhound/e-fidget-0.png",
"char.player.e-aim-0": "chars/vine-ranger/e-aim-0.png",   // … -aim-1; s se e ne n
"char.player.e-aimwalk-0": "chars/vine-ranger/e-aimwalk-0.png", // … through -7
"anim": { "draw": 2, "fidget": 3 }                        // optional; these are the defaults
```

At the defaults, an 8-frame `draw` lasts 16 ticks (0.53 s) and an 8-frame
`fidget` 24 ticks (0.8 s). `anim` is per theme, not per kind.

**Action clips (`attack`, `hurt`, `death`).** These play with or without art.
Without frames of its own, each lasts its fixed window (6, 8 and 18 ticks) on a
borrowed pose, exactly as before. With frames, it lasts `frames × tpf` ticks,
or the fixed window if that is longer (the last frame holds), so a drawn clip
always plays whole. At the defaults an 8-frame `attack` lasts 16 ticks, an
8-frame `hurt` 24 and an 8-frame `death` 40. The effects tied to the fixed
window keep it whatever the art:

- `attack`: the held-weapon swing (melee) or recoil (ranged) takes 6 ticks,
  then the weapon is back at rest while the clip plays on. The lunge also
  takes the first 6 ticks, at 30% when the clip is drawn. The held weapon
  stays visible over an attack clip, so draw the body, not the weapon.
- `hurt`: the white hit flash covers the clip's first 3 ticks (the hit lands
  one tick after the state starts, so at tpf 3 frame 0 is never seen). Put
  the impact on frame 1.
- `death`: a drawn death gets no topple. The body stays opaque, fades out over
  the clip's last 18 ticks, and is gone when the clip ends.

**Attacks that start from a sim event.** The lobber's shell and a hive spire's
budding or spreading raise no weapon cooldown, so the renderer starts their
`attack` from the sim event (`lob`; `hiveSpawn` and `hiveSpread`, on the spire
that buds, not the bud). The table of such events is `EVENT_STARTS` in
`src/render/animTracker.ts`. The clip starts on the event's own tick even when
the frame that first sees it runs later (a slow frame, a hitstop). An
event-started attack plays only drawn frames: without `char.lobber.*-attack-*`
art the lobber looks exactly as it did before, with no borrowed pose and no
lunge.

A new trigger restarts the clip from frame 0. Keep an attack clip no longer
than the kind's attack interval, or its tail is never seen: a wrench swings
every 15 ticks, so 7 frames at tpf 2 (14 ticks) play whole and 8 frames
(16 ticks) lose their last tick. Start and end the clip on the idle pose.

**Key grammar.** Each state takes up to 8 frames per drawn direction:
`char.<name>.<dir>-<state>-<n>` with `<n>` ∈ `0..7`. Frames must be
**contiguous from 0** — the first missing index ends the clip (a gap after it
is ignored). Loop states cycle their frames forever (phase-shifted per entity
so crowds don't move in lockstep); one-shots play once from the state's start
and **hold their last frame** until the window closes.

**Cadence.** Each state has a default ticks-per-frame — `idle` 12, `walk` 6,
`attack` 2, `hurt` 3, `roll` 3, `death` 5, `draw` 2, `fidget` 3, `aim` = `idle`'s,
`aimwalk` = `walk`'s — overridable per state via the
manifest `anim` section (integers 1..30). Frame selection is a pure function
of sim tick + entity id: deterministic on every device and replay.

**Backward compatibility (exact).** The legacy keys keep working unchanged:

- `char.<name>.<dir>-idle` ≡ the single `idle` frame.
- `char.<name>.<dir>-step` ≡ the second frame of a synthesized 2-frame `walk`
  clip: `walk = [idle, step]` (just `[idle]` when `step` is missing).
- A theme that ships ONLY idle/step renders **exactly as today**.
- New-grammar clips WIN over the synthesis: if `…-walk-0`… exists, `-step` is
  ignored for the walk cycle (it still backs the synthesis where walk clips
  are absent for some other direction).

**Per-state fallback chains (exact).** A state with no frames of its own
borrows the **first frame only** of the next state in its chain that has any
(a held stand-in pose — the engine's procedural motion layer still lunges/
flinches/topples on top, so borrowed states read correctly):

- `idle` → `idle` (procedural art guarantees it always exists)
- `walk` → `walk` → `idle` (via the legacy synthesis above)
- `attack` → `attack` → `walk` frame 0 → `idle`
- `hurt` → `hurt` → `idle`
- `roll` → `roll` → `walk` frame 0 → `idle`
- `death` → `death` → `hurt` frame 0 → `idle`
- `draw`, `fidget`, `aim`, `aimwalk` → nothing (drawn-only; see above)

Direction fallback (`se→s`, `e→s`, `ne→e→s`, `n→s`) applies BEFORE state
fallback: the drawn direction is chosen first, then that direction's clips
resolve. Only when a character has no `char.*` idle art at all does it fall to
its `unit.*` sprite, then to procedural art — which implements every state via
the same chains, so a zero-asset theme still animates.

The engine also layers **procedural motion** (walk lean+bob, idle breathing,
attack lunge, hurt flinch, roll tumble + landing squash, death topple+fade) as
subtle transform offsets around the feet anchor — themes get it for free; it
composes with any frames you ship. Where a pack draws a state itself (2+
frames), the procedural twin steps aside: a drawn walk or idle loop drops the
bob, breath, hover or pulse cycle; a drawn `death` keeps the fade (over its last
18 ticks) but not the topple; a drawn `attack` keeps 30% of the lunge. Tuning lives in
`src/render/motion.ts` (`MOTION` table).

### Held weapons (`weapon.<id>.<view>-<state>-<n>` + `weapons`)

A character holding a carried weapon (pistol, wrench, knife, sledgehammer, the
guns; never natural armament like fangs or claws) draws it from the pack. **A
weapon no pack in the chain draws is not drawn at all**: there is no
procedural stand-in.

- **Keys.** `weapon.<id>.<view>-idle-<n>` (a loop while held) and
  `weapon.<id>.<view>-attack-<n>` (a one-shot spread evenly over the attack
  window: the shot, or the swing). `n` runs 0..7, contiguous from 0. `<id>` is
  the weapon id in `src/game/data/items.ts`.
- **Views** are where the weapon POINTS on screen: `e` profile, `se` 3/4
  down-forward, `s` at the camera (foreshortened), `ne` 3/4 up-away, `n` away
  from the camera. The west half is these mirrored, so never draw `w/sw/nw`.
  A missing view borrows `se→e`, `s→se→e`, `ne→e`, `n→ne→e`; a view needs its
  idle loop to count.
- **Grid.** Frames are drawn on the pack's character pixel grid (`artScale`:
  96 px bodies → a forearm is ~12 px, a fist ~7x8) and are blitted UNSCALED
  with nearest filtering. Any canvas size; transparent background.
- **Grip and muzzle.** Per weapon and view, in that view's frame pixels
  (origin top-left), in the manifest's top-level `weapons` section:

  ```json
  "weapons": { "pistol": { "e": { "grip": [3, 6], "muzzle": [14, 2] } } }
  ```

  `grip` is the pixel that sits under the wielder's fist; every frame of the
  view is registered to it. `muzzle` (the head, for melee) is where a mod glow
  centres; it defaults to the grip.
- **What the engine does.** The body's 8-way facing picks the view: aiming
  (an engaged NPC, an attack in the last 1.5 s, a strafing player) points the
  weapon along the facing, level at the fist; otherwise it is at low-ready,
  one 45° sector toward the ground (profile → `se`; facing the camera →
  mirrored `se`, across the body). Facing `ne`/`n` it draws behind the body.
  The grip pixel lands on the fist the current body frame draws (measured per
  frame in `src/render/handAnchors.ts` by `scripts/assets/hand_anchors.py`),
  and the body's own fist is redrawn over the grip unless the weapon points at
  the camera. A melee weapon with no `attack` frames chops by stepping through
  the views (overhead, over, strike, follow-through).

- **Layers (optional).** `weapon.<id>.<view>-glow-<n>` is the weapon's
  essence accent alone, in pale ink, on the same canvas as the view's frames.
  With it, the renderer leaves the weapon's own colours alone and colours and
  pulses only this layer from the weapon's mods (`composeWeaponSkin`); without
  it the whole sprite is tinted, as before. `weapon.<id>.<view>-mod-<modId>-<n>`
  is a generated attachment one mod adds (frost fins, an igniter, a Tesla
  coil, a canister drum), drawn over the weapon when it carries that mod, in
  `MOD_LAYER_ORDER` (`src/render/sprites.ts`). Both loop on the idle clock.

## Fallback semantics (exact)

For each sprite key, resolution walks a **theme chain**: `[active theme, settlement]`
(just `[settlement]` when settlement is active):

1. First manifest in the chain that **mentions** the key wins.
   - value is a path → use that file.
   - value is `null` → use the built-in procedural art (explicit opt-out; the
     chain stops, settlement's art is NOT used).
2. No manifest mentions the key → built-in procedural art.
3. A resolved file that **fails to load** (404, corrupt) logs a warning and
   degrades to the built-in procedural art for that key only. Nothing crashes;
   nothing renders blank.

Names: `active.names[archetype]` → `settlement.names[archetype]` → title-cased
archetype key (`door.open` → "Door Open"). Palette scalars (`background`,
`uiAccent`, `floorTint`) and per-key `tiles`/`entities` colors resolve the same
way: active → settlement → built-in constant. `anim` cadences too: active theme's
`anim.<state>` → settlement's → the engine default.

So a **partial theme is always safe**: theme five sprites and two names and
everything else stays settlement.

## Adding a new theme, end to end

1. `mkdir public/themes/<id>` — id is lowercase `[a-z0-9-]+` (e.g. `swamp`).
2. Drop asset PNGs in the folder (any subfolder layout you like — the manifest
   maps keys to paths, the engine imposes no file naming beyond the
   `s-idle` rule under "Character art convention"). To *generate* the
   art with the local ComfyUI pipeline (seed sweeps, IPAdapter anchoring,
   palette locking, VLM gating), follow **`docs/sprite-generation.md`** — the
   `scripts/assets/` toolchain that built the `swampspace` pack.
3. Write `public/themes/<id>/manifest.json` against the schema above. Start
   partial; add keys as art lands.
4. Add `{ "id": "<id>", "name": "<Display Name>" }` to `public/themes/index.json`.
5. Verify: `pnpm exec vitest run src/render/theme.test.ts` (schema guards), then
   `pnpm run dev` and open `http://localhost:5173/?theme=<id>` — the console
   warns about every dropped/failed key. Runtime hot-swap for A/B eyeballing:
   open with `?e2e` and run `window.__setTheme('<id>')` / `window.__setTheme('settlement')`
   in devtools, or `theme <id>` via the debug CLI/MCP.
6. Screenshot proof: `bash e2e/run-theme.sh` records the same seeded scene in
   settlement vs your theme (set `THEME_ID=<id>`).

## Engine invariants (do not break)

- `src/game/` must never import or read theme data — themes are render/ui only.
- Theme switching must never touch world state, serialization, or the RNG.
- Every key must degrade gracefully: missing → fallback chain, never a crash.
