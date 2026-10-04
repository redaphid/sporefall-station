// The indoor skins and props resolve through the real createArt registry: a
// theme that ships the indoor art draws it, and one that does not (city, test,
// the 48px base pack) draws exactly what it drew before the skins existed.

import { describe, expect, it } from 'vitest'
import { Texture, type Renderer } from 'pixi.js'
import { Tile } from '../game/levelgen/level'
import { createArt, TILE_ACCENT_EVERY, type SpriteTextures, type WallCapTextures } from './art'

/** Every procedural texture is a fresh object, so identity tells them apart. */
const fakeRenderer = { generateTexture: () => new Texture() } as unknown as Renderer

const pool = (n: number): Texture[] => Array.from({ length: n }, () => new Texture())
const caps = (): WallCapTextures => ({ edge: new Texture(), inner: new Texture() })

/** Coordinates and hashes clear of the accent cadence. */
const SPOTS = [
  [0, 0, 1],
  [1, 0, 5],
  [0, 1, 9],
  [3, 7, 16],
  [12, 5, 33],
] as const

describe('ArtRegistry.tile with an indoor skin', () => {
  it('draws the skin pool when the theme ships it, and the plain tile without the skin', () => {
    const deck = pool(3)
    const floor = pool(1)
    const art = createArt(fakeRenderer, { tiles: { deck, floor } })
    for (const [x, y, h] of SPOTS) {
      expect(deck).toContain(art.tile(Tile.Floor, h, x, y, 'deck'))
      expect(art.tile(Tile.Floor, h, x, y)).toBe(floor[0])
    }
  })

  it('a theme without the skin draws the plain tile exactly, themed or procedural', () => {
    const floor = pool(2)
    const themed = createArt(fakeRenderer, { tiles: { floor } })
    const procedural = createArt(fakeRenderer, {})
    for (const [x, y, h] of SPOTS) {
      expect(themed.tile(Tile.Floor, h, x, y, 'deck')).toBe(themed.tile(Tile.Floor, h, x, y))
      expect(procedural.tile(Tile.Floor, h, x, y, 'deck')).toBe(procedural.tile(Tile.Floor, h, x, y))
      expect(procedural.tile(Tile.Wall, h, x, y, 'bulkhead')).toBe(procedural.tile(Tile.Wall, h, x, y))
      expect(procedural.tile(Tile.Wall, h, x, y, 'pillar')).toBe(procedural.tile(Tile.Wall, h, x, y))
    }
  })

  it('accents come from the skin, never from the plain tile it replaces', () => {
    const deck = pool(2)
    const deckAccent = pool(1)
    const sprites: SpriteTextures = { tiles: { deck, floor: pool(1) }, tileAccents: { floor: pool(1) } }
    expect(deck).toContain(createArt(fakeRenderer, sprites).tile(Tile.Floor, TILE_ACCENT_EVERY, 2, 2, 'deck'))
    sprites.tileAccents = { ...sprites.tileAccents, deck: deckAccent }
    expect(createArt(fakeRenderer, sprites).tile(Tile.Floor, TILE_ACCENT_EVERY, 2, 2, 'deck')).toBe(deckAccent[0])
  })

  it('a macro-sliced skin lays its slices by position from its own macro declaration', () => {
    const deck = pool(4)
    const art = createArt(fakeRenderer, { tiles: { deck }, tileMacro: { deck: 2, floor: 3 } })
    for (const [x, y, h] of SPOTS) expect(art.tile(Tile.Floor, h, x, y, 'deck')).toBe(deck[(y % 2) * 2 + (x % 2)])
  })

  it('a pillar wears its own art, else the bulkhead, else the plain wall', () => {
    const pillar = pool(1)
    const bulkhead = pool(1)
    const wall = pool(1)
    expect(createArt(fakeRenderer, { tiles: { pillar, bulkhead, wall } }).tile(Tile.Wall, 1, 4, 4, 'pillar')).toBe(pillar[0])
    expect(createArt(fakeRenderer, { tiles: { bulkhead, wall } }).tile(Tile.Wall, 1, 4, 4, 'pillar')).toBe(bulkhead[0])
    expect(createArt(fakeRenderer, { tiles: { wall } }).tile(Tile.Wall, 1, 4, 4, 'pillar')).toBe(wall[0])
  })
})

describe('ArtRegistry.wallCap with an indoor skin', () => {
  it('bulkheads and pillars wear the bulkhead caps when the theme ships them', () => {
    const bulkhead = caps()
    const wall = caps()
    const art = createArt(fakeRenderer, { tiles: { bulkhead: pool(1), wall: pool(1) }, tileCaps: { bulkhead, wall } })
    expect(art.wallCap(Tile.Wall, 'bulkhead')).toBe(bulkhead)
    expect(art.wallCap(Tile.Wall, 'pillar')).toBe(bulkhead)
    expect(art.wallCap(Tile.Wall)).toBe(wall)
  })

  it('a skinned body shipped without caps is drawn as shipped, not under the plain wall caps', () => {
    const art = createArt(fakeRenderer, { tiles: { bulkhead: pool(1), wall: pool(1) }, tileCaps: { wall: caps() } })
    expect(art.wallCap(Tile.Wall, 'bulkhead')).toBeUndefined()
    expect(art.wallCap(Tile.Wall, 'pillar')).toBeUndefined()
  })

  it('a theme without the indoor art caps a skinned wall exactly like the plain one', () => {
    const wall = caps()
    const themed = createArt(fakeRenderer, { tiles: { wall: pool(1) }, tileCaps: { wall } })
    expect(themed.wallCap(Tile.Wall, 'bulkhead')).toBe(wall)
    expect(themed.wallCap(Tile.Wall, 'pillar')).toBe(wall)
    const procedural = createArt(fakeRenderer, {})
    const plain = procedural.wallCap(Tile.Wall)
    expect(plain).toBeDefined()
    expect(procedural.wallCap(Tile.Wall, 'bulkhead')).toBe(plain)
    expect(procedural.wallCap(Tile.Wall, 'pillar')).toBe(plain)
  })

  it('floors take no cap, skinned or not', () => {
    const art = createArt(fakeRenderer, { tiles: { deck: pool(1) }, tileCaps: { bulkhead: caps() } })
    expect(art.wallCap(Tile.Floor, 'deck')).toBeUndefined()
  })
})

describe('ArtRegistry.entity with an indoor art key', () => {
  it('draws the indoor prop art when the theme ships it', () => {
    const door = new Texture()
    const generator = new Texture()
    const tank = new Texture()
    const art = createArt(fakeRenderer, {
      props: { 'bulkhead-door': door, generator, 'coolant-tank': tank, tv: new Texture(), barrel: new Texture() },
    })
    expect(art.entity('indoor:door')).toBe(door)
    expect(art.entity('indoor:generator')).toBe(generator)
    expect(art.entity('indoor:barrel')).toBe(tank)
    expect(art.entity('door')).not.toBe(door)
    expect(art.entity('generator')).not.toBe(generator)
  })

  it('falls back to the plain key when the theme ships no indoor art', () => {
    const tv = new Texture()
    const barrel = new Texture()
    const art = createArt(fakeRenderer, { props: { tv, barrel } })
    expect(art.entity('indoor:generator')).toBe(tv)
    expect(art.entity('indoor:barrel')).toBe(barrel)
    for (const key of ['door', 'door.open', 'door.locked', 'bunk', 'crate', 'shelf'])
      expect(art.entity(`indoor:${key}`), key).toBe(art.entity(key))
  })

  it('a hit flash is the plain key silhouette', () => {
    const art = createArt(fakeRenderer, { props: { 'bulkhead-door': new Texture() } })
    expect(art.entityFlash('indoor:door')).toBe(art.entityFlash('door'))
    expect(art.entityFlash('indoor:generator')).toBe(art.entityFlash('generator'))
  })
})
