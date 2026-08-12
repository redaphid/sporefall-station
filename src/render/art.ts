import { Container, Graphics, Sprite, Texture, type Renderer } from 'pixi.js'
import { Tile } from '../game/levelgen/level'
import { modPickupColor } from './modColors'
import { WEAPON_CANVAS, weaponShape, type WeaponShape } from './weaponArt'
import { DEFAULT_TPF, type AnimStateName } from './animState'
import { DIRS5, type Dir5 } from './theme'
import { pickTileVariant } from './tileSelect'

// These are LOGICAL sizes. The default swampspace-hires pack reads crisp at
// 32/48 because its manifest declares `artScale: 2` — themeLoader bakes its art
// at double texture density over the same logical footprint, so the layout/
// camera/draw code never changes. Flipping BOTH constants to 2× — `TILE_PX =
// 64`, `CHAR_PX = 96` (below) — remains a valid render-layer-only experiment
// (the sim never sees pixels, so determinism is unaffected); the weapon-scale
// fix in sprites.ts (`CHAR_PX/48`) keeps the held weapon pinned/proportional at
// either size. The hi-res B video (~/Videos/backseat/art-hires) was recorded
// from the 64/96 build.
export const TILE_PX = 32

/** Character sprite canvas: 48×48 over the 32px tiles. Feet-anchored, so a
 * character stands 1.5 tiles tall and overlaps the tile behind/above it
 * (docs/themes.md "Character art convention"). */
export const CHAR_PX = 48

/**
 * Maps logical art keys to textures. v1 is procedural colored shapes;
 * swapping this file for a real tileset/spritesheet is the upgrade path.
 */
export const TILE_VARIANTS = 3

/** Sides a ground tile can receive a wall-contact shadow or ground-seam
 * overlay on (tilemap.ts lays these over the base tiles — the cheap ambient
 * occlusion that grounds walls and makes surface boundaries deliberate). */
export type OverlaySide = 'n' | 's' | 'e' | 'w'

/** ~1 in this many tiles of a themed surface swaps its variant for a rare
 * accent tile (root cluster, grate, spore patch…) when the theme ships any. */
export const TILE_ACCENT_EVERY = 17

export interface ArtRegistry {
  /** `hash` is any deterministic per-coordinate value (tilemap hashes tx,ty).
   * It picks among themed variants/accents or the procedural TILE_VARIANTS —
   * same hash, same texture, on every device. Pass the tile coordinates too
   * when you have them: surfaces a theme declares in `macroTiles` then pick
   * their variant by position (adjacent macro slices land adjacently). */
  tile(tileId: number, hash?: number, tx?: number, ty?: number): Texture
  /** Context-placed RGBA decal pool for a surface (`tile.<name>.overlay`) —
   * empty when the theme ships none. Placement: tileSelect.planTileOverlays. */
  tileOverlayPool(tileId: number): readonly Texture[]
  /** Macro side (N of an N×N sliced pool) the active theme declares for a
   * surface, if any — the tilemap feeds it back into variant/overlay planning. */
  tileMacro(tileId: number): number | undefined
  /** Wall-contact shadow strip for a ground tile's `side` facing the wall:
   * strongest below a wall (side 'n' — the wall stands to the tile's north),
   * subtle on the flanks. Overlay-blended by the tilemap. */
  wallShadow(side: OverlaySide): Texture
  /** Soft seam strip for a boundary where a LOWER surface (street water) meets
   * a higher one (deck/grass) — drawn on the lower tile's edge. */
  groundSeam(side: OverlaySide): Texture
  entity(archetype: string): Texture
  /** White silhouette of the entity texture, swapped in during hit flash. For
   * a character pass its current drawn facing so the flash keeps the pose. */
  entityFlash(archetype: string, dir?: Dir5): Texture
  /** True when this archetype draws as a billboarded character sprite (which
   * should flip left/right, not rotate like the top-down procedural blobs). */
  isCharacterSprite(archetype: string): boolean
  /** 5-direction sprite set (s/se/e/ne/n × idle/step) for an archetype. Theme
   * file art wins when loaded; every character archetype always gets at least
   * the procedural fallback set, so no theme gap can break a facing. Missing
   * drawn directions borrow a neighbor at draw time (DIR_FALLBACK). */
  characterSet(archetype: string): CharSet | undefined
  /** The walking (step) pose for an archetype, if a step frame exists. */
  walkStep(archetype: string): Texture | undefined
  /** Fire flicker frames (empty → caller falls back to the procedural flame). */
  flameFrames(): readonly Texture[]
  /** A one-shot effect clip's frames, by effect key. Empty if not loaded. */
  effectFrames(key: EffectKey): readonly Texture[]
  /** White bullet core disc (radius 8px) — tinted/scaled per composed style. */
  bulletCore(): Texture
  /** Soft white radial halo — the sprite FALLBACK glow when the energy shader
   * is unavailable (additive, tinted per style). */
  bulletGlow(): Texture
  /** The active theme's bullet base art (`sprites.projectile`, docs/themes.md),
   * if any — mod visual traits compose ON TOP of it (tint/stretch/energy).
   * Undefined → the procedural tintable white disc carries the whole look. */
  themedBullet(): Texture | undefined
  /** Cadence (sim ticks per frame) for an animation state — theme override or
   * the engine default. */
  animTpf(state: AnimStateName): number
  /** Grip-anchored held-weapon silhouette for a weapon id (procedural, cached).
   * Drawn pointing +x with the grip near the left edge (WEAPON_ANCHOR), so the
   * renderer pins it to the hand and rotates it around the grip for the swing.
   * Every id resolves to a shape (unknown → generic rod), so it's never blank. */
  weaponTexture(weaponId: string): Texture
}

export type EffectKey = 'hit' | 'explosion' | 'pickup' | 'blood'

export interface DirPose {
  idle?: Texture
  step?: Texture
  /** Named-state frame clips (docs/themes.md "Animation states"). Legacy
   * idle/step above stay authoritative when a state ships no clip — the
   * animator synthesizes walk = [idle, step] (animState.effectiveClips). */
  clips?: Partial<Record<AnimStateName, Texture[]>>
}
/** A billboarded character's 5 DRAWN directions (docs/themes.md): s, se, e,
 * ne, n. The west half (w/sw/nw) is the east art mirrored at draw time, so
 * five sprites cover all eight compass headings. Missing directions borrow a
 * neighbor via DIR_FALLBACK when the renderer picks a pose. */
export type CharSet = Partial<Record<Dir5, DirPose>>

export interface SpriteTextures {
  /** Themed tile art, keyed by tile NAME (street/sidewalk/floor/wall/grass/
   * exit): each entry is a non-empty variant pool the tilemap alternates by
   * coordinate hash. Absent name → procedural art for that tile. */
  tiles?: Record<string, Texture[]>
  /** Rare accent pools per tile name (see TILE_ACCENT_EVERY). */
  tileAccents?: Record<string, Texture[]>
  /** Context-placed RGBA decal pools per tile name (`tile.<name>.overlay`). */
  tileOverlays?: Record<string, Texture[]>
  /** Macro-slicing declarations per tile name (manifest `macroTiles`). */
  tileMacro?: Record<string, number>
  player?: Texture
  cop?: Texture
  item?: Texture
  prop?: Texture
  /** New character idle textures, keyed by archetype. */
  thug?: Texture
  scientist?: Texture
  robot?: Texture
  /** Walk (step) frames, keyed by archetype. */
  thugStep?: Texture
  scientistStep?: Texture
  robotStep?: Texture
  /** Themed projectile/grenade base textures — weapon-mod visual traits (tints,
   * trails) compose ON TOP of these; procedural dots when absent. */
  projectile?: Texture
  grenade?: Texture
  /** Directional character sets (5 drawn dirs), keyed by archetype. */
  chars?: Record<string, CharSet>
  /** Per-item pickup sprites, keyed by item id (bat/knife/medkit/…). */
  items?: Record<string, Texture>
  /** World prop sprites, keyed by archetype (barrel/atm/…). */
  props?: Record<string, Texture>
  /** Fire flicker frames, cycled by the animator. */
  flames?: Texture[]
  /** One-shot effect clips. */
  hit?: Texture[]
  explosion?: Texture[]
  pickup?: Texture[]
  blood?: Texture[]
}

/** Palette overrides for the PROCEDURAL art, resolved from the active theme
 * chain (name-keyed; parsed to numbers upstream in theme.ts). */
export interface ArtPalette {
  tiles?: Record<string, number>
  entities?: Record<string, number>
}

/**
 * Per-archetype sprite BULK — a multiplier on the drawn billboard only.
 *
 * The Mireclaw Alpha borrows the thug's directional set (see CHARSET_ALIAS
 * below) and was therefore PIXEL-IDENTICAL to the commonest enemy in the game:
 * same body, same palette, same size. Until it gets its own art (see
 * docs/assets/boss-art-brief.md) this is the cheap half of the fix — an Alpha
 * that is half again the size of its own brood reads as a different creature at
 * a glance, and the size difference survives whatever art lands later.
 *
 * Deliberately NOT the collision radius: entity radius stays 0.35 so the boss
 * still fits through a one-tile hatch. Its longer claw reach (1.5 vs the bat's
 * 1.3) is what makes the extra bulk felt in the fight.
 */
export const ARCHETYPE_SCALE: Record<string, number> = {
  boss: 1.5,
}

// Archetypes that borrow another archetype's directional set (bouncers use the
// cop body; the boss uses the thug; shopkeepers use the civilian).
const CHARSET_ALIAS_BASE: Record<string, string> = {
  player: 'player',
  cop: 'cop',
  gangster: 'gangster',
  bouncer: 'cop',
  thug: 'thug',
  boss: 'thug',
  civilian: 'civilian',
  scientist: 'scientist',
  robot: 'robot',
  shopkeeper: 'civilian',
  // #78 Sporefall threat roster. Membership of THIS map is what `isCharacterSprite`
  // tests, so until each of these was listed it fell past the character path
  // entirely and drew as the generic procedural entity blob — six different
  // enemies rendering as the same grey eyeball in normal play.
  //
  // Each maps to ITSELF, not to a borrowed body: they are the creatures the pack
  // has bespoke art for, and aliasing e.g. brute->thug would just reintroduce the
  // pixel-identical problem ARCHETYPE_SCALE exists to paper over. If a kind's art
  // is missing the lookup still falls through to its own procedural set, which is
  // per-archetype distinct — so a partial art drop degrades, it does not break.
}

/** The six Sporefall threats' bespoke character art, kept SEPARATE from the base
 * map on purpose.
 *
 * The `newEnemyArt` setting is OFF by default, and the point of an off-by-default
 * flag is that a player who never touches it is PROVABLY unaffected. So the
 * default path is the original `CHARSET_ALIAS_BASE`, byte-for-byte what shipped
 * before this art existed — not a second branch that reconstructs it and merely
 * looks the same. Turning the setting on ADDS these entries; turning it off does
 * not subtract anything, because nothing was ever added.
 *
 * Each maps to ITSELF, not a borrowed body: aliasing e.g. brute->thug would just
 * reintroduce the pixel-identical problem. A missing file still falls through to
 * the per-archetype procedural set, so a partial art drop degrades rather than
 * breaks.
 *
 * REMOVAL PLAN: this is scaffolding, not architecture. When the colour pass
 * lands and the art is accepted, fold these into CHARSET_ALIAS_BASE and delete
 * the flag. A feature flag nobody removes is its own debt — see the
 * INFECTION_ENABLED precedent, where a dead constant hid a whole unfinished
 * system. */
const NEW_ENEMY_CHARSET: Record<string, string> = {
  brute: 'brute',
  cinder: 'cinder',
  sporeling: 'sporeling',
  stalker: 'stalker',
  lurker: 'lurker',
  pod: 'pod',
}

// World props/furnishings mapped to the closest existing themed prop sprite
// (value = a `prop.<name>` sprite key, i.e. an entry in SpriteTextures.props).
// Reuse is deliberate: several furniture archetypes share one on-theme texture
// where the silhouette reads right (a weapons locker wears the cryo-terminal;
// supply cabinet wears the nutrient dispenser; a desk wears the console). Only
// archetypes with NO acceptable sprite fall through to a DISTINCT procedural
// draw (FURNITURE_SHAPE) instead of a bespoke texture.
export const PROP_SPRITE: Record<string, string> = {
  barrel: 'barrel',
  atm: 'atm',
  vending: 'vending-machine',
  tv: 'tv',
  toilet: 'toilet',
  locker: 'locker',
  cabinet: 'cabinet',
  desk: 'desk',
  // Station machinery reuses the terminal/console art (previously fell through
  // to the character eyeball). The Cryo Terminal object is literally that art.
  cryoTerminal: 'atm',
  generator: 'tv',
}

// Consumables/weapons that reuse another item's sprite.
// Pickup item ids mapped to the closest themed `item.<id>` sprite key. This
// exists because the sprite keys are ART names while the values here are GAME
// item ids (`data/items.ts`), and the two vocabularies drifted.
//
// It is load-bearing, not cosmetic: the fallback chain ends at `sprites.item`,
// which resolves to `item.default` — and in every shipped theme `item.default`
// is the SAME file as `item.medkit` (biogel-kit.png). So an unaliased pickup
// does not render as a neutral box, it renders as a MEDKIT, and the floor fills
// with fake healing. Anything droppable therefore needs an entry here or its own
// art.
//
// `grenade` is the sharpest case: `items/spore-grenade.png` ships in both themes
// and was never once drawn, because the manifest keys it `item.grenade-item`
// while the entity archetype is `pickup.grenade`.
export const ITEM_ALIAS: Record<string, string> = {
  bandage: 'medkit',
  // Thrown explosives — the spore-grenade art was already on disk.
  grenade: 'grenade-item',
  freezeGrenade: 'grenade-item',
  gasGrenade: 'grenade-item',
  // The banana peel is a THROWABLE and had no entry here at all, so it fell
  // through to `sprites.item` — i.e. `item.default`, which every shipped theme
  // maps to the same file as `item.medkit`. It is in the floor-2+ loot table and
  // in SHOP_STOCK, so ~1 fake medkit per floor was guaranteed. Wearing the
  // grenade's pod is still not ITS art, but it is at least honest about the
  // CATEGORY: you can see it is something you throw, not something you heal
  // with. Bespoke art is queued (see _mycel-results/sprite-inventory.md).
  banana: 'grenade-item',
  // Thrown flasks share the molotov's bottle silhouette.
  chloroform: 'molotov',
  // Long guns wear the scatter-blaster; sidearms wear the spore-pistol.
  machinegun: 'shotgun',
  flamethrower: 'shotgun',
  freezeRay: 'shotgun',
  tranquilizer: 'pistol',
  stunGun: 'pistol',
  // Blunt melee wears the root-club.
  sledgehammer: 'bat',
}

// Archetypes with a dedicated character sprite; the rest reuse the cop body.
const SPRITE_ARCHETYPES: Record<string, keyof SpriteTextures> = {
  player: 'player',
  thug: 'thug',
  scientist: 'scientist',
  robot: 'robot',
  cop: 'cop',
  gangster: 'cop',
  bouncer: 'cop',
}
const STEP_ARCHETYPES: Record<string, keyof SpriteTextures> = {
  thug: 'thugStep',
  scientist: 'scientistStep',
  robot: 'robotStep',
}

/** palette.tiles is name-keyed (pure layer, no Tile enum); map back to ids. */
const TILE_ID_BY_NAME: Record<string, number> = {
  street: Tile.Street,
  sidewalk: Tile.Sidewalk,
  floor: Tile.Floor,
  wall: Tile.Wall,
  grass: Tile.Grass,
  exit: Tile.Exit,
}

const TILE_COLORS: Record<number, number> = {
  [Tile.Street]: 0x33333c,
  [Tile.Sidewalk]: 0x4c4c56,
  [Tile.Floor]: 0x63523f,
  [Tile.Wall]: 0x1b1b24,
  [Tile.Grass]: 0x2e5d3a,
  [Tile.Exit]: 0xd4af37,
}

/** For each bevelled wall corner variant, the polygon of the KEPT wall area
 * (unit coords) — the missing triangle is the outside corner it exposes. The
 * tilemap draws the outside ground tile underneath, so the cut shows pavement. */
const CUT = 0.5
const WALL_CUT_POLY: Record<number, number[]> = {
  [Tile.WallCutNW]: [CUT, 0, 1, 0, 1, 1, 0, 1, 0, CUT],
  [Tile.WallCutNE]: [0, 0, 1 - CUT, 0, 1, CUT, 1, 1, 0, 1],
  [Tile.WallCutSE]: [0, 0, 1, 0, 1, 1 - CUT, 1 - CUT, 1, 0, 1],
  [Tile.WallCutSW]: [0, 0, 1, 0, 1, 1, CUT, 1, 0, 1 - CUT],
}

const ENTITY_COLORS: Record<string, number> = {
  player: 0x7fd17f,
  thug: 0xd17f7f,
  boss: 0xe0483f,
  gangster: 0xc95fa0,
  bouncer: 0x8f7a5a,
  cop: 0x7f9fd1,
  civilian: 0xd1c47f,
  shopkeeper: 0xb87fd1,
  lurker: 0x6a4b8a, // bruised violet: the corner ambusher reads as "wrong" on sight

  scientist: 0xd9e4e8,
  robot: 0x8fa1b3,
  crate: 0x9c6b3f,
  default: 0xcccccc,
}

// Interior furnishings (feat/levelgen-fill-interiors). Archetypes with a good
// themed prop texture resolve to it via PROP_SPRITE; the rest fall here and are
// drawn as a DISTINCT procedural silhouette (bed, table, shelf, planter, egg
// pod, slatted crate) — never a generic box and never the character eyeball.
// A 'box' shape is the last-resort tinted footprint for anything unmapped.
export type FurnitureShape = 'bunk' | 'table' | 'bench' | 'shelf' | 'plant' | 'crate' | 'pod' | 'box'

/** Object archetypes that draw as a bespoke procedural furniture silhouette
 * (rather than a themed prop texture). Exported so art-resolution tests can
 * assert every interior archetype is covered — no eyeball, no bare box. */
export const FURNITURE_SHAPE: Record<string, FurnitureShape> = {
  bunk: 'bunk',
  table: 'table',
  bench: 'bench',
  shelf: 'shelf',
  plant: 'plant',
  crate: 'crate',
  pod: 'pod',
  // A defender-built junk barrier (fortify behavior): the slatted-crate
  // silhouette reads "pile of junk in the doorway" without bespoke art.
  barricade: 'crate',
  // The Spore Node is a stationary bog organ — the egg-pod ovoid reads it right
  // (previously fell through to the character eyeball fallback).
  sporeNode: 'pod',
  // These normally resolve to a themed prop texture (see PROP_SPRITE); the box
  // is only their fallback silhouette if a theme ships no prop art at all.
  desk: 'box',
  cabinet: 'box',
  locker: 'box',
  cryoTerminal: 'box',
  generator: 'box',
}

/** Base tint per furniture archetype (theme palette entities can override). */
const FURNITURE_COLORS: Record<string, number> = {
  bunk: 0x6b7a8f,
  desk: 0x8a6a3f,
  shelf: 0x7a5a34,
  cabinet: 0xcfd6da,
  bench: 0xa9b4bb,
  locker: 0x59616b,
  table: 0x9c6b3f,
  plant: 0x2e7d46,
  crate: 0x6b4d26,
  barricade: 0x5a5248, // scrap-grey junk pile, distinct from the loot crate
  pod: 0x4f7a3a,
  sporeNode: 0x4f7a3a,
  cryoTerminal: 0x5a7b8f,
  generator: 0x6a6f78,
}

/** Scale a 0xRRGGBB colour by `f` (each channel clamped to 255). */
const shade = (color: number, f: number): number => {
  const ch = (c: number): number => Math.max(0, Math.min(255, Math.round(c * f)))
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff)
}

export const createArt = (
  renderer: Renderer,
  sprites: SpriteTextures = {},
  palette: ArtPalette = {},
  animTpfs: Partial<Record<AnimStateName, number>> = {},
  /** Draw the six Sporefall threats' bespoke art instead of the generic
   * procedural blobs. Defaults FALSE so the untouched path is the historical
   * one. Purely local presentation — never reaches the sim or the wire. */
  newEnemyArt = false,
): ArtRegistry => {
  // Flag ON adds the six; flag OFF leaves the base map exactly as it was.
  const CHARSET_ALIAS: Record<string, string> = newEnemyArt
    ? { ...CHARSET_ALIAS_BASE, ...NEW_ENEMY_CHARSET }
    : CHARSET_ALIAS_BASE
  const tileCache = new Map<number, Texture>()
  const entityCache = new Map<string, Texture>()

  // Themed procedural colors: theme palette wins over the built-in constants.
  const tileColors: Record<number, number> = { ...TILE_COLORS }
  for (const [name, color] of Object.entries(palette.tiles ?? {})) {
    const id = TILE_ID_BY_NAME[name]
    if (id !== undefined) tileColors[id] = color
  }
  const entityColors: Record<string, number> = { ...ENTITY_COLORS, ...palette.entities }

  // Deterministic pseudo-noise for texture detail (not the sim's rng)
  const hash2 = (a: number, b: number): number => {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f)
    h = Math.imul(h ^ (h >>> 15), 0x2545f491)
    return ((h >>> 16) & 0xffff) / 0xffff
  }

  const drawTile = (tileId: number, variant: number): Texture => {
    const T = TILE_PX
    // Bevelled wall corner: transparent canvas, wall-coloured polygon with the
    // outside triangle cut away (the tilemap layers ground art underneath).
    const cutPoly = WALL_CUT_POLY[tileId]
    if (cutPoly) {
      const wall = tileColors[Tile.Wall] ?? 0x1b1b24
      const g = new Graphics().rect(0, 0, T, T).fill({ color: 0, alpha: 0 })
      const pts = cutPoly.map((v) => v * T)
      g.poly(pts).fill(wall)
      g.poly(pts).stroke({ width: 2, color: 0x000000, alpha: 0.3 })
      // Same top highlight the square wall carries, clipped to the kept width.
      const topY = 0
      const xs = cutPoly.filter((_, i) => i % 2 === 0 && cutPoly[i + 1] === 0).map((v) => v * T)
      if (xs.length >= 2) g.rect(Math.min(...xs), topY, Math.max(...xs) - Math.min(...xs), 3).fill(0x2a2a36)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    const color = tileColors[tileId] ?? 0xff00ff
    const g = new Graphics().rect(0, 0, TILE_PX, TILE_PX).fill(color)
    switch (tileId) {
      case Tile.Wall: {
        // Brick courses
        for (let row = 0; row < 4; row++) {
          const y = row * (T / 4)
          g.rect(0, y, T, 1).fill({ color: 0x000000, alpha: 0.35 })
          const offset = row % 2 === 0 ? T / 3 : T * 0.66
          g.rect(offset, y, 1, T / 4).fill({ color: 0x000000, alpha: 0.3 })
        }
        g.rect(0, 0, T, 3).fill(0x2a2a36)
        break
      }
      case Tile.Floor: {
        // Wood planks
        for (let row = 0; row < 4; row++) {
          g.rect(0, row * (T / 4), T, 1).fill({ color: 0x000000, alpha: 0.18 })
        }
        for (let i = 0; i < 3; i++) {
          const x = hash2(variant * 31 + i, 7) * T
          const y = (Math.floor(hash2(i, variant) * 4) + 0.5) * (T / 4)
          g.rect(x, y - 1, 3, 1).fill({ color: 0x000000, alpha: 0.25 })
        }
        break
      }
      case Tile.Street: {
        // Asphalt speckle (cracks tile too visibly with only 3 variants)
        for (let i = 0; i < 8; i++) {
          const x = hash2(i, variant * 17) * T
          const y = hash2(variant * 13, i) * T
          g.rect(x, y, 1.5, 1.5).fill({ color: 0xffffff, alpha: 0.05 })
        }
        break
      }
      case Tile.Sidewalk: {
        g.rect(0, 0, T, 1).fill({ color: 0xffffff, alpha: 0.08 })
        g.rect(0, 0, 1, T).fill({ color: 0xffffff, alpha: 0.06 })
        break
      }
      case Tile.Grass: {
        for (let i = 0; i < 10; i++) {
          const x = hash2(i * 3, variant * 11) * T
          const y = hash2(variant * 5, i * 7) * T
          g.rect(x, y, 2, 2).fill({ color: 0x1e4227, alpha: 0.7 })
        }
        break
      }
      case Tile.Exit: {
        // Gold pad with a chevron pointing onward
        g.rect(3, 3, T - 6, T - 6).stroke({ width: 2, color: 0x8a6d1f })
        g.poly([T * 0.3, T * 0.3, T * 0.7, T * 0.5, T * 0.3, T * 0.7]).fill(0x8a6d1f)
        break
      }
    }
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  /** Themed wall art clipped to a bevel-cut polygon, cached per cut tile id —
   * so corner cuts wear the same dressed wall the straight runs do. */
  const themedCutCache = new Map<number, Texture>()
  const themedCut = (tileId: number, wallTex: Texture): Texture => {
    let tex = themedCutCache.get(tileId)
    if (!tex) {
      const holder = new Container()
      // Transparent backer pins bounds to the full tile.
      holder.addChild(new Graphics().rect(0, 0, TILE_PX, TILE_PX).fill({ color: 0, alpha: 0 }))
      const spr = new Sprite(wallTex)
      spr.width = TILE_PX
      spr.height = TILE_PX
      const mask = new Graphics().poly(WALL_CUT_POLY[tileId].map((v) => v * TILE_PX)).fill(0xffffff)
      spr.mask = mask
      holder.addChild(spr, mask)
      tex = renderer.generateTexture(holder)
      holder.destroy({ children: true })
      themedCutCache.set(tileId, tex)
    }
    return tex
  }

  const TILE_NAME_BY_ID: Record<number, string> = Object.fromEntries(
    Object.entries(TILE_ID_BY_NAME).map(([name, id]) => [id, name]),
  )

  const tile = (tileId: number, hash = 0, tx?: number, ty?: number): Texture => {
    const name = TILE_NAME_BY_ID[tileId]
    const variants = name ? sprites.tiles?.[name] : undefined
    if (variants && variants.length > 0) {
      // Rare accents ride the same hash (different bits pick which one).
      const accents = sprites.tileAccents?.[name]
      if (accents && accents.length > 0 && hash % TILE_ACCENT_EVERY === 0) {
        return accents[(hash >>> 5) % accents.length]
      }
      const macro = tx !== undefined && ty !== undefined ? sprites.tileMacro?.[name] : undefined
      return variants[pickTileVariant(variants.length, macro, tx ?? 0, ty ?? 0, hash)]
    }
    // Bevelled corners wear the themed wall art (clipped) when the theme ships one.
    const themedWall = sprites.tiles?.wall
    if (WALL_CUT_POLY[tileId] && themedWall && themedWall.length > 0) {
      return themedCut(tileId, themedWall[0])
    }
    const key = tileId * TILE_VARIANTS + (hash % TILE_VARIANTS)
    let tex = tileCache.get(key)
    if (!tex) {
      tex = drawTile(tileId, hash % TILE_VARIANTS)
      tileCache.set(key, tex)
    }
    return tex
  }

  // ---- Ground overlay strips (wall-contact shadows + surface seams) --------
  // Banded alpha rects approximate a gradient without shaders; generated once
  // per side and overlay-blended by the tilemap. Deterministic, theme-agnostic.
  const overlayCache = new Map<string, Texture>()
  const overlayStrip = (kind: string, side: OverlaySide, depth: number, alpha: number): Texture => {
    const key = `${kind}:${side}`
    let tex = overlayCache.get(key)
    if (tex) return tex
    const T = TILE_PX
    const g = new Graphics().rect(0, 0, T, T).fill({ color: 0, alpha: 0 })
    const bands = 4
    for (let i = 0; i < bands; i++) {
      const a = alpha * (1 - i / bands)
      const d0 = (depth * i) / bands
      const d1 = (depth * (i + 1)) / bands
      if (side === 'n') g.rect(0, d0, T, d1 - d0).fill({ color: 0x000000, alpha: a })
      else if (side === 's') g.rect(0, T - d1, T, d1 - d0).fill({ color: 0x000000, alpha: a })
      else if (side === 'w') g.rect(d0, 0, d1 - d0, T).fill({ color: 0x000000, alpha: a })
      else g.rect(T - d1, 0, d1 - d0, T).fill({ color: 0x000000, alpha: a })
    }
    tex = renderer.generateTexture(g)
    g.destroy()
    overlayCache.set(key, tex)
    return tex
  }
  // A wall to the tile's north drops the strongest shade (light reads as
  // coming from the top of the screen); flanks are subtle, south is faint.
  const wallShadow = (side: OverlaySide): Texture =>
    side === 'n' ? overlayStrip('ws-n', 'n', 11, 0.34) : side === 's' ? overlayStrip('ws-s', 's', 5, 0.14) : overlayStrip(`ws-${side}`, side, 7, 0.2)
  const groundSeam = (side: OverlaySide): Texture => overlayStrip(`gs-${side}`, side, 4, 0.24)

  const drawEntity = (archetype: string, colorOverride?: number): Texture => {
    if (archetype === 'door') {
      const g = new Graphics()
        .rect(0, 0, TILE_PX, TILE_PX)
        .fill(colorOverride ?? 0x8a6a3f)
        .rect(2, 2, TILE_PX - 4, TILE_PX - 4)
        .stroke({ width: 2, color: 0x000000, alpha: 0.45 })
        .circle(TILE_PX * 0.78, TILE_PX * 0.5, 2)
        .fill(0x222222)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'door.locked') {
      // Locked door: same panel, but colder and wearing a visible padlock —
      // "this one won't just open" must read at a glance from across a room.
      const g = new Graphics()
        .rect(0, 0, TILE_PX, TILE_PX)
        .fill(colorOverride ?? 0x6f5636)
        .rect(2, 2, TILE_PX - 4, TILE_PX - 4)
        .stroke({ width: 2, color: 0x000000, alpha: 0.45 })
        // padlock body + shackle, centred
        .roundRect(TILE_PX * 0.5 - 5, TILE_PX * 0.5 - 2, 10, 9, 2)
        .fill(0xd8b13a)
        .circle(TILE_PX * 0.5, TILE_PX * 0.5 - 3, 4)
        .stroke({ width: 2.5, color: 0xd8b13a })
        .circle(TILE_PX * 0.5, TILE_PX * 0.5 + 2.5, 1.6)
        .fill(0x3a2e10)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'door.open') {
      // Open door: slim panel against the jamb
      const g = new Graphics().rect(0, 0, 6, TILE_PX).fill(colorOverride ?? 0x8a6a3f)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'fire') {
      // A stacked flame: deep orange body, yellow core, white-hot heart.
      const c = TILE_PX / 2
      const g = new Graphics()
        .circle(c, c + 3, TILE_PX * 0.44)
        .fill(colorOverride ?? 0xff4a12)
        .circle(c, c + 4, TILE_PX * 0.3)
        .fill(colorOverride ?? 0xff9a1e)
        .circle(c, c + 5, TILE_PX * 0.16)
        .fill(colorOverride ?? 0xffe45a)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'projectile' || archetype === 'grenade') {
      const color = archetype === 'grenade' ? 0x3a4a3a : 0xffe066
      const size = archetype === 'grenade' ? 6 : 4
      const g = new Graphics().circle(size, size, size).fill(colorOverride ?? color)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype.startsWith('pickup.')) {
      const s = TILE_PX * 0.45
      const g = new Graphics()
        .roundRect(0, 0, s, s, 3)
        .fill(colorOverride ?? 0xd4af37)
        .roundRect(0, 0, s, s, 3)
        .stroke({ width: 2, color: 0x000000, alpha: 0.4 })
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    // A weapon-mod pickup: a diamond gem tinted with the mod TYPE's own unique
    // colour (see modColors.ts) so a kid can tell which mod it is from across a
    // room. Unknown/new ids fall back to a neutral slate.
    if (archetype.startsWith('mod.')) {
      const gem = modPickupColor(archetype.slice('mod.'.length))
      const r = TILE_PX * 0.28
      const g = new Graphics()
        .poly([r, 0, r * 2, r, r, r * 2, 0, r])
        .fill(colorOverride ?? gem)
        .poly([r, 0, r * 2, r, r, r * 2, 0, r])
        .stroke({ width: 2, color: 0x101018, alpha: 0.6 })
        .poly([r, r * 0.35, r * 1.55, r, r, r * 1.65, r * 0.45, r])
        .stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 })
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    // Interior furnishings without a themed prop texture: each archetype draws a
    // DISTINCT, recognizable silhouette (bed, table, bench, shelf, planter, egg
    // pod, slatted crate) so a furnished room never reads as a herd of eyeballed
    // creatures or a wall of identical boxes. Fully deterministic — fixed
    // geometry per archetype, palette-driven colours, no randomness. The
    // transparent full-tile backer makes every furnishing share the same tile
    // footprint as the real prop sprites (loaded at TILE_PX).
    const shape = FURNITURE_SHAPE[archetype]
    if (shape !== undefined) {
      const base = colorOverride ?? entityColors[archetype] ?? FURNITURE_COLORS[archetype] ?? entityColors.default
      const dk = colorOverride ?? shade(base, 0.6)
      const lt = colorOverride ?? shade(base, 1.3)
      const line = colorOverride ?? 0x101018
      const sAlpha = colorOverride ? 1 : 0.45
      const seamA = colorOverride ? 1 : 0.3
      const T = TILE_PX
      const g = new Graphics().rect(0, 0, T, T).fill({ color: 0, alpha: 0 })
      switch (shape) {
        case 'bunk': {
          // Low bed: dark frame, lighter mattress, a pillow block at the head.
          const fx = 3
          const fy = T * 0.3
          const fw = T - 6
          const fh = T * 0.46
          g.roundRect(fx, fy, fw, fh, 3).fill(dk)
          g.roundRect(fx, fy, fw, fh, 3).stroke({ width: 2, color: line, alpha: sAlpha })
          g.roundRect(fx + 1.5, fy + 2, fw - 3, fh - 5, 2).fill(base)
          g.roundRect(fx + 2.5, fy + 3, fw * 0.3, fh - 8, 2).fill(lt) // pillow
          g.rect(fx + fw * 0.42, fy + 2, 1.5, fh - 5).fill({ color: line, alpha: seamA }) // blanket seam
          break
        }
        case 'table': {
          // Flat surface on four short legs peeking at the corners.
          const legH = T * 0.3
          const legY = T * 0.5
          g.rect(5, legY, 3, legH).fill(dk)
          g.rect(T - 8, legY, 3, legH).fill(dk)
          g.roundRect(3, T * 0.34, T - 6, T * 0.2, 2).fill(base)
          g.roundRect(3, T * 0.34, T - 6, T * 0.2, 2).stroke({ width: 2, color: line, alpha: sAlpha })
          g.rect(3, T * 0.34, T - 6, 2).fill(lt) // lit near edge
          break
        }
        case 'bench': {
          // Lab bench: a long low counter with a recessed under-shelf.
          g.roundRect(3, T * 0.34, T - 6, T * 0.16, 2).fill(base)
          g.roundRect(3, T * 0.34, T - 6, T * 0.16, 2).stroke({ width: 2, color: line, alpha: sAlpha })
          g.rect(3, T * 0.34, T - 6, 2).fill(lt)
          g.roundRect(5, T * 0.56, T - 10, T * 0.14, 1).fill(dk) // under-shelf
          break
        }
        case 'shelf': {
          // Upright unit carved by two horizontal divider shelves.
          const pad = T * 0.16
          const s = T - pad * 2
          g.roundRect(pad, pad, s, s, 2).fill(base)
          g.roundRect(pad, pad, s, s, 2).stroke({ width: 2, color: line, alpha: sAlpha })
          for (let i = 1; i <= 2; i++) {
            const y = pad + (s * i) / 3
            g.rect(pad, y - 1, s, 2).fill(dk)
            g.rect(pad, y - 1, s, 1).fill({ color: lt, alpha: colorOverride ? 1 : 0.5 })
          }
          break
        }
        case 'plant': {
          // Terracotta pot with a cluster of swamp-green foliage blobs.
          const cx = T / 2
          const potTop = T * 0.62
          const potBot = T * 0.86
          const potW = T * 0.34
          const pot = [cx - potW / 2, potTop, cx + potW / 2, potTop, cx + potW * 0.36, potBot, cx - potW * 0.36, potBot]
          g.poly(pot).fill(colorOverride ?? 0x6b4a2c)
          g.poly(pot).stroke({ width: 2, color: line, alpha: sAlpha })
          const leaf = colorOverride ?? FURNITURE_COLORS.plant
          const leafDk = colorOverride ?? shade(FURNITURE_COLORS.plant, 0.7)
          const leafLt = colorOverride ?? shade(FURNITURE_COLORS.plant, 1.25)
          g.circle(cx - 6, T * 0.5, 5).fill(leafDk)
          g.circle(cx + 6, T * 0.5, 5).fill(leafDk)
          g.circle(cx, T * 0.4, 7).fill(leaf)
          g.circle(cx, T * 0.28, 5).fill(leafLt)
          break
        }
        case 'crate': {
          // Wooden cargo box: corner frame + a cross brace — reads as a crate
          // even before the themed cargo-pod texture loads.
          const pad = T * 0.12
          const s = T - pad * 2
          g.rect(pad, pad, s, s).fill(base)
          g.rect(pad, pad, s, s).stroke({ width: 2, color: line, alpha: sAlpha })
          g.moveTo(pad, pad).lineTo(pad + s, pad + s).stroke({ width: 2.5, color: dk, alpha: colorOverride ? 1 : 0.6 })
          g.moveTo(pad + s, pad).lineTo(pad, pad + s).stroke({ width: 2.5, color: dk, alpha: colorOverride ? 1 : 0.6 })
          g.rect(pad, pad, s, 3).fill(lt)
          break
        }
        case 'pod': {
          // Dormant spore egg: a rounded ovoid with a lighter dome and a seam.
          const cx = T / 2
          const cy = T * 0.54
          g.ellipse(cx, cy, T * 0.3, T * 0.4).fill(base)
          g.ellipse(cx, cy, T * 0.3, T * 0.4).stroke({ width: 2, color: line, alpha: sAlpha })
          g.ellipse(cx, cy - T * 0.06, T * 0.18, T * 0.22).fill(lt) // top sheen
          g.rect(cx - 0.75, cy - T * 0.34, 1.5, T * 0.66).fill({ color: dk, alpha: colorOverride ? 1 : 0.5 }) // seam
          break
        }
        default: {
          // 'box' — last-resort tinted footprint for an unmapped/theme-less prop.
          const pad = T * 0.14
          const s = T - pad * 2
          g.roundRect(pad, pad, s, s, 3).fill(base)
          g.roundRect(pad, pad, s, s, 3).stroke({ width: 2, color: line, alpha: sAlpha })
          g.rect(pad, pad, s, 3).fill({ color: lt, alpha: colorOverride ? 1 : 0.6 })
          break
        }
      }
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    const color = colorOverride ?? entityColors[archetype] ?? entityColors.default
    const r = TILE_PX * 0.35
    const g = new Graphics()
      // body with a darker rim
      .circle(r, r, r)
      .fill(color)
      .circle(r, r, r)
      .stroke({ width: 2, color: 0x000000, alpha: 0.4 })
      // shoulder shading
      .circle(r, r, r * 0.72)
      .stroke({ width: 1.5, color: 0xffffff, alpha: 0.12 })
      // eyes looking +x; sprite rotation orients them
      .circle(r * 1.45, r * 0.72, r * 0.14)
      .fill(colorOverride ?? 0x101018)
      .circle(r * 1.45, r * 1.28, r * 0.14)
      .fill(colorOverride ?? 0x101018)
      // held-item nub at the hand
      .circle(r * 1.55, r * 1.5, r * 0.18)
      .fill(colorOverride ?? 0x3a3a44)
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  const spriteForArchetype = (archetype: string): Texture | undefined => {
    const key = SPRITE_ARCHETYPES[archetype]
    if (key) return sprites[key] as Texture | undefined
    // Themed projectile/grenade base art; mod-driven visual traits (elemental
    // tints etc.) are applied by the renderer on top of whatever base loads.
    if (archetype === 'projectile') return sprites.projectile
    if (archetype === 'grenade') return sprites.grenade
    if (archetype.startsWith('pickup.')) {
      const id = archetype.slice('pickup.'.length)
      return sprites.items?.[id] ?? sprites.items?.[ITEM_ALIAS[id]] ?? sprites.item
    }
    const propKey = PROP_SPRITE[archetype]
    if (propKey) return sprites.props?.[propKey]
    if (archetype === 'crate' || archetype.startsWith('prop')) return sprites.prop
    return undefined
  }

  /** Procedural billboarded character on the CHAR_PX (48×48) canvas: a chunky
   * figure with per-direction head/eye/hand placement so all five drawn facings
   * read at a glance. Feet sit on the canvas bottom (the sprite is anchored
   * bottom-centre). This is the guaranteed fallback art when a theme ships no
   * character files — every direction exists for every character archetype.
   * Colours come from the palette-merged entityColors, so themes recolour the
   * procedural bodies too. */
  const drawCharacter = (
    archetype: string,
    dir: Dir5,
    frame: 'idle' | 'step',
    colorOverride?: number,
  ): Texture => {
    const color =
      colorOverride ?? entityColors[archetype] ?? entityColors[CHARSET_ALIAS[archetype]] ?? entityColors.default
    const dark = colorOverride ?? shade(color, 0.55)
    const light = colorOverride ?? shade(color, 1.25)
    const outline = colorOverride ?? 0x101018
    const cx = CHAR_PX / 2
    const lift = frame === 'step' ? 1 : 0 // step pose bobs the body, feet stay planted
    // Per-direction lean: diagonals shift head/torso toward the heading so
    // se/ne read as 3/4 views; e is a full profile.
    const headDx = { s: 0, se: 2.5, e: 3.5, ne: 2.5, n: 0 }[dir]
    const bodyDx = { s: 0, se: 1, e: 2, ne: 1, n: 0 }[dir]
    const profile = dir === 'e'

    // Transparent full-canvas rect pins generateTexture's bounds to the whole
    // 48×48 canvas, so the feet anchor (bottom-centre) is exact.
    const g = new Graphics().rect(0, 0, CHAR_PX, CHAR_PX).fill({ color: 0, alpha: 0 })

    // Legs: idle stands square; step strides — trailing leg lifted, leading planted.
    const legW = 5
    const legH = 10
    const legY = 47 - legH
    if (frame === 'idle') {
      g.rect(cx - 7 + bodyDx, legY, legW, legH).fill(dark)
      g.rect(cx + 2 + bodyDx, legY, legW, legH).fill(dark)
    } else {
      g.rect(cx - 9 + bodyDx, legY + 2, legW, legH - 2).fill(dark)
      g.rect(cx + 4 + bodyDx, legY, legW, legH).fill(dark)
    }

    // Torso: narrower in profile so east reads slimmer than south.
    const torsoW = profile ? 14 : 18
    g.roundRect(cx - torsoW / 2 + bodyDx, 20 - lift, torsoW, 19, 6)
      .fill(color)
      .roundRect(cx - torsoW / 2 + bodyDx, 20 - lift, torsoW, 19, 6)
      .stroke({ width: 2, color: outline, alpha: 0.5 })

    // Arms: both visible facing camera-ish; one leading arm in profile.
    const arm = colorOverride ?? shade(color, 0.8)
    if (dir === 's' || dir === 'se') {
      g.rect(cx - torsoW / 2 - 3 + bodyDx, 22 - lift, 3, 10).fill(arm)
      g.rect(cx + torsoW / 2 + bodyDx, 22 - lift, 3, 10).fill(arm)
    } else if (profile) {
      g.rect(cx + 2 + bodyDx, 23 - lift, 4, 10).fill(arm)
    }

    // Head, lightened so it pops against the torso.
    g.circle(cx + headDx, 13 - lift, 8.5)
      .fill(light)
      .circle(cx + headDx, 13 - lift, 8.5)
      .stroke({ width: 2, color: outline, alpha: 0.5 })
    // Back-of-head cap for away-facing poses (n/ne) — no face visible.
    if (dir === 'n' || dir === 'ne') {
      g.circle(cx + headDx, 11.5 - lift, 6.8).fill(colorOverride ?? shade(color, 0.7))
    }

    // Eyes: two facing camera, two shifted on the se diagonal, one in profile.
    const eye = colorOverride ?? 0x101018
    if (dir === 's') {
      g.circle(cx - 3.5, 12 - lift, 1.7).fill(eye)
      g.circle(cx + 3.5, 12 - lift, 1.7).fill(eye)
    } else if (dir === 'se') {
      g.circle(cx + headDx - 1, 12.5 - lift, 1.7).fill(eye)
      g.circle(cx + headDx + 4.5, 12.5 - lift, 1.7).fill(eye)
    } else if (profile) {
      g.circle(cx + headDx + 4.5, 12 - lift, 1.7).fill(eye)
    }

    // Held-item nub at the leading hand (hidden when facing away).
    if (dir === 's' || dir === 'se' || profile) {
      g.circle(cx + torsoW / 2 + bodyDx + 2, 30 - lift, 2.5).fill(colorOverride ?? 0x3a3a44)
    }

    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  // Procedural directional sets, cached per ARCHETYPE (not alias) so aliased
  // bodies keep their own colour (boss red, bouncer tan, …).
  const procCharCache = new Map<string, CharSet>()
  const procCharSet = (archetype: string): CharSet => {
    let set = procCharCache.get(archetype)
    if (!set) {
      set = {}
      for (const d of DIRS5) {
        set[d] = { idle: drawCharacter(archetype, d, 'idle'), step: drawCharacter(archetype, d, 'step') }
      }
      procCharCache.set(archetype, set)
    }
    return set
  }

  const characterSet = (archetype: string): CharSet | undefined => {
    const alias = CHARSET_ALIAS[archetype]
    if (!alias) return undefined
    // An archetype's OWN art wins over the set it borrows, so dropping
    // `char.boss.*` files into a theme pack promotes the Mireclaw Alpha off the
    // thug body with no code change (same for bouncer/shopkeeper/gangster).
    // Then the alias' art; then the procedural set, which guarantees every
    // character archetype renders in all five drawn directions with zero files.
    return sprites.chars?.[archetype] ?? sprites.chars?.[alias] ?? procCharSet(archetype)
  }

  const isCharacterSprite = (archetype: string): boolean => archetype in CHARSET_ALIAS

  const walkStep = (archetype: string): Texture | undefined => {
    const key = STEP_ARCHETYPES[archetype]
    return key ? (sprites[key] as Texture | undefined) : undefined
  }

  const flameFrames = (): readonly Texture[] => sprites.flames ?? []

  // Shared bullet textures — generated ONCE, then tinted/scaled per bullet so
  // every projectile batches on the same two textures (no per-frame generation).
  let bulletCoreTex: Texture | undefined
  const bulletCore = (): Texture => {
    if (!bulletCoreTex) {
      const g = new Graphics().circle(8, 8, 8).fill(0xffffff)
      bulletCoreTex = renderer.generateTexture(g)
      g.destroy()
    }
    return bulletCoreTex
  }
  let bulletGlowTex: Texture | undefined
  const bulletGlow = (): Texture => {
    if (!bulletGlowTex) {
      // Concentric falloff rings approximate a radial gradient (no shaders here —
      // this texture IS the fallback for GPUs where the energy shader won't build).
      const g = new Graphics()
      const R = 24
      for (let i = 6; i >= 1; i--) {
        g.circle(R, R, (R * i) / 6).fill({ color: 0xffffff, alpha: 0.05 + (6 - i) * 0.03 })
      }
      bulletGlowTex = renderer.generateTexture(g)
      g.destroy()
    }
    return bulletGlowTex
  }

  // ---- Held weapons --------------------------------------------------------
  // Procedural grip-anchored silhouettes, drawn pointing +x on a fixed canvas so
  // the renderer rotates them around the grip to swing. One texture per shape,
  // cached; the mod SKIN (tint/scale/glow) is applied by the renderer on top, so
  // a modded weapon reuses the same base texture (no per-mod generation).
  const drawWeapon = (shape: WeaponShape): Texture => {
    const { w, h, grip } = WEAPON_CANVAS
    const my = h / 2 // grip / handle centre-line
    // Transparent full-canvas rect pins generateTexture's bounds so the grip
    // anchor (grip/w, 0.5) is exact regardless of the drawn silhouette.
    const g = new Graphics().rect(0, 0, w, h).fill({ color: 0, alpha: 0 })
    const wood = 0x8a5a2b
    const steel = 0xb8bcc6
    const darkSteel = 0x6d7079
    switch (shape) {
      case 'hammer': {
        // Long haft + a big blocky head at the tip — an unmistakable sledge.
        g.rect(grip, my - 1.5, w - grip - 12, 3).fill(wood)
        g.roundRect(w - 15, my - 8, 13, 16, 2).fill(steel)
        g.roundRect(w - 15, my - 8, 13, 16, 2).stroke({ width: 1.5, color: 0x101018, alpha: 0.6 })
        g.rect(w - 15, my - 8, 4, 16).fill({ color: 0xffffff, alpha: 0.18 }) // struck-face glint
        break
      }
      case 'club': {
        // Tapered bat: thin at the grip, fat at the business end.
        g.poly([grip, my - 2, w - 3, my - 6, w - 3, my + 6, grip, my + 2]).fill(wood)
        g.poly([grip, my - 2, w - 3, my - 6, w - 3, my + 6, grip, my + 2]).stroke({ width: 1, color: 0x3a2410, alpha: 0.5 })
        g.circle(grip + 2, my, 2.5).fill(0x5a3a1a) // pommel knob
        break
      }
      case 'blade': {
        // Short knife: dark grip + guard, then a bright triangular blade.
        const bx = grip + 9
        g.rect(grip, my - 2, 9, 4).fill(0x2a2a30) // grip
        g.rect(bx - 1, my - 4, 2, 8).fill(darkSteel) // guard
        g.poly([bx, my - 3, w - 6, my, bx, my + 3]).fill(steel) // blade
        g.poly([bx, my - 3, w - 6, my, bx, my + 3]).stroke({ width: 0.75, color: 0x101018, alpha: 0.5 })
        break
      }
      case 'gun': {
        // Semi-auto PISTOL, barrel along +x on the aim line (y = my), grip hung
        // below the rear so the hand (grip anchor) holds the handle and the
        // muzzle points straight down the aim. Reads grip + guard + slide + barrel.
        const gx = grip
        const gunGrip = 0x33363d
        const frameY = my - 5 // top of the slide/frame
        // Grip/handle: angled down and slightly back from the frame rear.
        const handle = [gx - 1, frameY + 4, gx + 6, frameY + 4, gx + 4, my + 9, gx - 3, my + 8]
        g.poly(handle).fill(gunGrip)
        g.poly(handle).stroke({ width: 1, color: 0x101018, alpha: 0.55 })
        // Trigger guard: a ring under the frame just forward of the grip.
        g.circle(gx + 8, my + 3, 3).stroke({ width: 1.5, color: 0x2a2c33 })
        // Slide / frame: the boxy top body.
        g.roundRect(gx - 1, frameY, 22, 7, 1.5).fill(steel)
        g.roundRect(gx - 1, frameY, 22, 7, 1.5).stroke({ width: 1, color: 0x101018, alpha: 0.5 })
        // Rear slide serrations + a rear sight nub — grip texture that reads at zoom.
        g.rect(gx + 1, frameY, 1.5, 7).fill({ color: 0x101018, alpha: 0.32 })
        g.rect(gx + 4, frameY, 1.5, 7).fill({ color: 0x101018, alpha: 0.32 })
        g.rect(gx, frameY - 1.5, 3, 1.5).fill(darkSteel) // rear sight
        // Barrel: a slimmer bar from the slide to the muzzle, centred on the aim line.
        const barX = gx + 20
        g.rect(barX, my - 2, w - barX - 3, 4).fill(darkSteel)
        g.rect(barX + 2, frameY + 1, 2, 1.5).fill(steel) // front sight
        // Muzzle at the very tip, on the aim line where bullets exit.
        g.circle(w - 3, my, 2).fill(0x1b1c21)
        break
      }
      case 'rod': {
        // Generic fallback rod — plain but visible, so no weapon is ever blank.
        g.rect(grip, my - 2, w - grip - 3, 4).fill(darkSteel)
        g.rect(grip, my - 2, w - grip - 3, 4).stroke({ width: 1, color: 0x101018, alpha: 0.5 })
        break
      }
    }
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  const weaponCache = new Map<string, Texture>()
  const weaponTexture = (weaponId: string): Texture => {
    // Key by SHAPE, not id — every gun shares one texture, tinted per mod skin.
    const shape = weaponShape(weaponId)
    let tex = weaponCache.get(shape)
    if (!tex) {
      tex = drawWeapon(shape)
      weaponCache.set(shape, tex)
    }
    return tex
  }

  const effectFrames = (key: EffectKey): readonly Texture[] => sprites[key] ?? []

  const entity = (archetype: string): Texture => {
    const real = spriteForArchetype(archetype)
    if (real) return real
    let tex = entityCache.get(archetype)
    if (!tex) {
      tex = drawEntity(archetype)
      entityCache.set(archetype, tex)
    }
    return tex
  }

  const flashCache = new Map<string, Texture>()
  const entityFlash = (archetype: string, dir?: Dir5): Texture => {
    // Characters flash as a white silhouette of their current facing so the
    // pose (and the 48px feet-anchored canvas) never jumps during the flash.
    const character = archetype in CHARSET_ALIAS
    const key = character ? `${archetype}|${dir ?? 's'}` : archetype
    let tex = flashCache.get(key)
    if (!tex) {
      tex = character ? drawCharacter(archetype, dir ?? 's', 'idle', 0xffffff) : drawEntity(archetype, 0xffffff)
      flashCache.set(key, tex)
    }
    return tex
  }

  const EMPTY_POOL: readonly Texture[] = []
  const tileOverlayPool = (tileId: number): readonly Texture[] => {
    const name = TILE_NAME_BY_ID[tileId]
    return (name ? sprites.tileOverlays?.[name] : undefined) ?? EMPTY_POOL
  }
  const tileMacroFor = (tileId: number): number | undefined => {
    const name = TILE_NAME_BY_ID[tileId]
    return name ? sprites.tileMacro?.[name] : undefined
  }

  return {
    tile,
    tileOverlayPool,
    tileMacro: tileMacroFor,
    wallShadow,
    groundSeam,
    entity,
    entityFlash,
    isCharacterSprite,
    characterSet,
    walkStep,
    flameFrames,
    effectFrames,
    bulletCore,
    bulletGlow,
    themedBullet: () => sprites.projectile,
    animTpf: (state) => animTpfs[state] ?? DEFAULT_TPF[state],
    weaponTexture,
  }
}
