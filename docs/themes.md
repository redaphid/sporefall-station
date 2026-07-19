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
    "tile.floor": "tiles/floor.png",        //   to this theme's folder, or
    "tile.wall": "/sprites/brick-wall.png", //   app-root-relative with a
    "fx.flame": ["fx/flame-1.png", "fx/flame-2.png"], // leading "/". fx.* keys
    "item.default": null         //   take ARRAYS (animation frames). `null`
  }                              //   means "force the built-in procedural art"
}                                //   (blocks fallback to the default theme).
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
| `tile.floor` | interior floor tile (drawn in a grid, should tile seamlessly) |
| `tile.wall` | wall tile (tiles seamlessly) |
| `char.<name>.<dir>-<frame>` | directional billboard character. `<name>` ∈ `player cop thug civilian scientist gangster robot`; `<dir>` ∈ `s se e ne n`; `<frame>` ∈ `idle step`. 70 keys total. See "Character art convention" below. |
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
way: active → city → built-in constant.

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
