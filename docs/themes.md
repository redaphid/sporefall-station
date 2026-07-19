# Themes — data-driven visual + flavor packs

A **theme** swaps the game's entire visual and flavor identity (sprites, palette,
entity display names) with **zero code changes and zero sim impact**. The sim
(`src/game/`) knows nothing about themes: a cop is always archetype `cop` in the
world and over the wire; a theme only changes how that cop *looks* and what the
UI *calls* it ("Bog Warden" in a swamp theme).

- Engine side: `src/render/theme.ts` (pure schema/validation/resolution),
  `src/render/themeLoader.ts` (fetch + pixi Assets baking), `src/render/themeState.ts`
  (active-theme name lookup for the UI).
- Theme packages live in `public/themes/<themeId>/` — one `manifest.json` plus
  the asset files it references.
- The current look is the default theme **`city`** (`public/themes/city/manifest.json`),
  which points at the legacy `public/sprites/` files.

## Selecting a theme

| Mechanism | Behavior |
|---|---|
| Settings panel (gear icon) | Persisted to localStorage (`sor.settings`, field `theme`). |
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
  { "id": "city", "name": "City" },
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
  // "Fallback semantics"). An empty manifest {} is valid: it renders as city.

  "palette": {
    "background": "#0b120b",     // canvas clear color
    "uiAccent":  "#7fd17f",      // exposed as CSS var --theme-accent on <html>
    "floorTint": "#c8ffc8",      // multiplied over the whole tile layer
    "tiles": {                   // procedural tile colors (used when a tile has
      "street":   "#1e2a1e",     //   no sprite); keys are exactly these six:
      "sidewalk": "#2a3a2a",     //   street sidewalk floor wall grass exit
      "floor":    "#3a4a2a",
      "wall":     "#101a10",
      "grass":    "#2e5d3a",
      "exit":     "#d4af37"
    },
    "entities": {                // procedural entity-blob colors, by archetype
      "cop": "#4a7a5a", "civilian": "#b0c090"
    }
  },

  "names": {                     // display names by archetype — SAME sim
    "cop": "Bog Warden",         //   behavior, themed presentation. Shown in
    "thug": "Mire Lurker",       //   the tap-inspect card title. Any archetype
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
| `tile.<name>` | ground/wall tile art, `<name>` ∈ `street sidewalk floor wall grass exit`. A single path OR an **array of variant paths** — the tilemap alternates variants by a deterministic per-coordinate hash, so big surfaces read as texture instead of one repeated stamp (same seed → same ground on every device). Should tile seamlessly. The wall's first variant is also clipped onto the bevelled corner-cut tiles. |
| `tile.<name>.accent` | OPTIONAL rare-detail pool for that surface (root cluster, vent grate, glowing spore patch…). One accent replaces the base variant on ~1/17 tiles, picked on the same coordinate hash. Array or single path. |
| `tile.<name>.overlay` | OPTIONAL pool of RGBA decals placed by CONTEXT, not by chance: the tilemap plans placements from the tile grid — wall bases, room corners (two adjacent walls → two overlapping decals), door thresholds, macro-cell plate seams, plus a rare open-floor clump (`src/render/tileSelect.ts` `planTileOverlays`). Author each decal with its mass biased toward the TOP edge of the tile; the renderer rotates it toward whichever edge earned it. This is how overgrowth "pools" against structure instead of being speckled into the base texture. Deterministic per coordinate — same moss on every device. |
| `char.<name>.<dir>-<frame>` | directional billboard character, LEGACY two-frame form. `<name>` ∈ `player cop thug civilian scientist gangster robot`; `<dir>` ∈ `s se e ne n`; `<frame>` ∈ `idle step`. 70 keys. See "Character art convention" below. |
| `char.<name>.<dir>-<state>-<n>` | directional character ANIMATION-STATE frame. `<state>` ∈ `idle walk attack hurt roll death`; `<n>` ∈ `0..7`, contiguous from 0. Same `<name>`/`<dir>` sets as above. See "Animation states" below. |
| `unit.player`, `unit.cop` | single-sprite billboard fallback (no directions) |
| `unit.<name>.idle`, `unit.<name>.step` | single-sprite two-frame walkers, `<name>` ∈ `thug scientist robot` |
| `item.default` | generic ground-item sprite |
| `item.<id>` | per-item pickup, `<id>` ∈ `pistol bat knife medkit cash shotgun molotov grenade-item` |
| `prop.default` | generic prop (crates etc.) |
| `prop.<name>` | `<name>` ∈ `barrel atm vending-machine tv toilet` |
| `projectile` | bullet base texture (small, oriented flying +x; rotated to heading). Weapon-mod visual traits (elemental tints etc.) are applied ON TOP of this texture at runtime — themes provide the base art, mods compose over it. |
| `grenade` | thrown grenade base texture (same composition rule) |
| `fx.flame` | **array** — looping fire frames (3 in city) |
| `fx.hit` | **array** — hit-spark clip (1 frame in city) |
| `fx.explosion` | **array** — explosion clip (3 frames in city) |
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

Archetypes that share a body keep sharing it (bouncer→cop, boss→thug,
shopkeeper→civilian): theming `char.cop.*` also reskins bouncers. Doors, fires,
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
- The `city` theme predates this convention: its legacy 3-direction art
  (front/side/back) is mapped onto `s`/`e`/`n` in its manifest and the diagonals
  fall back per the rules above.

### Animation states (`char.<name>.<dir>-<state>-<n>`)

Characters animate through six NAMED STATES, resolved every frame from sim
state (render-only — the sim knows nothing about animation):

| State | Kind | Triggered by | Window |
|---|---|---|---|
| `idle` | loop | nothing else active | — |
| `walk` | loop | entity is moving | while moving |
| `attack` | one-shot | an attack/throw fired (weapon cooldown observed starting) | 6 ticks |
| `hurt` | one-shot | took a hit (`status.hitFlashUntil`) | 8 ticks |
| `roll` | one-shot | dodge-roll active | the sim's roll window (12 ticks) |
| `death` | one-shot | entity died (render-side ghost; corpses leave the snapshot the same tick) | 18 ticks |

**Priority when several conditions hold at once (highest wins):**
`death > roll > hurt > attack > walk > idle`.

**Key grammar.** Each state takes up to 8 frames per drawn direction:
`char.<name>.<dir>-<state>-<n>` with `<n>` ∈ `0..7`. Frames must be
**contiguous from 0** — the first missing index ends the clip (a gap after it
is ignored). Loop states cycle their frames forever (phase-shifted per entity
so crowds don't move in lockstep); one-shots play once from the state's start
and **hold their last frame** until the window closes.

**Cadence.** Each state has a default ticks-per-frame — `idle` 12, `walk` 6,
`attack` 2, `hurt` 3, `roll` 3, `death` 5 — overridable per state via the
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

Direction fallback (`se→s`, `e→s`, `ne→e→s`, `n→s`) applies BEFORE state
fallback: the drawn direction is chosen first, then that direction's clips
resolve. Only when a character has no `char.*` idle art at all does it fall to
its `unit.*` sprite, then to procedural art — which implements every state via
the same chains, so a zero-asset theme still animates.

The engine also layers **procedural motion** (walk lean+bob, idle breathing,
attack lunge, hurt flinch, roll tumble + landing squash, death topple+fade) as
subtle transform offsets around the feet anchor — themes get it for free; it
composes with any frames you ship. Tuning lives in `src/render/motion.ts`
(`MOTION` table).

## Fallback semantics (exact)

For each sprite key, resolution walks a **theme chain**: `[active theme, city]`
(just `[city]` when city is active):

1. First manifest in the chain that **mentions** the key wins.
   - value is a path → use that file.
   - value is `null` → use the built-in procedural art (explicit opt-out; the
     chain stops, city's art is NOT used).
2. No manifest mentions the key → built-in procedural art.
3. A resolved file that **fails to load** (404, corrupt) logs a warning and
   degrades to the built-in procedural art for that key only. Nothing crashes;
   nothing renders blank.

Names: `active.names[archetype]` → `city.names[archetype]` → title-cased
archetype key (`door.open` → "Door Open"). Palette scalars (`background`,
`uiAccent`, `floorTint`) and per-key `tiles`/`entities` colors resolve the same
way: active → city → built-in constant. `anim` cadences too: active theme's
`anim.<state>` → city's → the engine default.

So a **partial theme is always safe**: theme five sprites and two names and
everything else stays city.

## Adding a new theme, end to end

1. `mkdir public/themes/<id>` — id is lowercase `[a-z0-9-]+` (e.g. `swamp`).
2. Drop asset PNGs in the folder (any subfolder layout you like — the manifest
   maps keys to paths, the engine imposes no file naming). To *generate* the
   art with the local ComfyUI pipeline (seed sweeps, IPAdapter anchoring,
   palette locking, VLM gating), follow **`docs/sprite-generation.md`** — the
   `scripts/assets/` toolchain that built the `swampspace` pack.
3. Write `public/themes/<id>/manifest.json` against the schema above. Start
   partial; add keys as art lands.
4. Add `{ "id": "<id>", "name": "<Display Name>" }` to `public/themes/index.json`.
5. Verify: `pnpm exec vitest run src/render/theme.test.ts` (schema guards), then
   `pnpm run dev` and open `http://localhost:5173/?theme=<id>` — the console
   warns about every dropped/failed key. Runtime hot-swap for A/B eyeballing:
   open with `?e2e` and run `window.__setTheme('<id>')` / `window.__setTheme('city')`
   in devtools, or `theme <id>` via the debug CLI/MCP.
6. Screenshot proof: `bash e2e/run-theme.sh` records the same seeded scene in
   city vs your theme (set `THEME_ID=<id>`).

## Engine invariants (do not break)

- `src/game/` must never import or read theme data — themes are render/ui only.
- Theme switching must never touch world state, serialization, or the RNG.
- Every key must degrade gracefully: missing → fallback chain, never a crash.
