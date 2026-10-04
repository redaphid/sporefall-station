// The tilemap and the entity layer draw an authored complex floor with the
// indoor skins and props, and the same level text without `complex` with the
// plain art. Both layers run for real over a createArt registry whose themed
// pools are distinct textures, so a sprite's texture says which pool drew it.

import { describe, expect, it } from 'vitest'
import { Container, Sprite, Texture, type Renderer } from 'pixi.js'
import { makeEntity } from '../game/entity'
import type { ComplexInfo } from '../game/levelgen/level'
import { levelFromJson } from '../game/levelgen/levelText'
import { spawnObject } from '../game/systems/objects'
import { addEntity, worldFromState, type World } from '../game/world'
import { createArt, type SpriteTextures, type WallCapTextures } from './art'
import { isIndoorLevel } from './indoorSkin'
import { EntityViews } from './sprites'
import { TilemapView } from './tilemap'

const fakeRenderer = { generateTexture: () => new Texture() } as unknown as Renderer
const pool = (n: number): Texture[] => Array.from({ length: n }, () => new Texture())
const caps = (): WallCapTextures => ({ edge: new Texture(), inner: new Texture() })

const COMPLEX: ComplexInfo = { biome: 'reactor', corridors: [], vents: [], wings: [] }

// Two pillars, (2,2) and (6,2), and a three-wall run.
const ROWS = [
  'HHHHHHHHH',
  'H.......H',
  'H.#...#.H',
  'H.......H',
  'H..###..H',
  'HHHHHHHHH',
]

const authored = (complex: ComplexInfo | undefined): World =>
  worldFromState({ level: levelFromJson(complex ? { rows: ROWS, complex } : { rows: ROWS }) })

const count = (rows: readonly string[], glyph: string): number => rows.join('').split(glyph).length - 1

const pack = () => {
  const s = {
    deck: pool(2),
    bulkhead: pool(2),
    pillar: pool(1),
    floor: pool(2),
    wall: pool(2),
    hull: pool(1),
    bulkheadCaps: caps(),
    wallCaps: caps(),
  }
  const sprites: SpriteTextures = {
    tiles: { deck: s.deck, bulkhead: s.bulkhead, pillar: s.pillar, floor: s.floor, wall: s.wall, hull: s.hull },
    tileCaps: { bulkhead: s.bulkheadCaps, wall: s.wallCaps },
  }
  return { s, sprites }
}

/** How many tilemap sprites draw a texture from `textures`. */
const drawnFrom = (view: TilemapView, textures: readonly Texture[]): number => {
  let n = 0
  for (const chunk of view.root.children as Container[])
    for (const child of chunk.children) if (textures.includes((child as Sprite).texture)) n++
  return n
}

describe('TilemapView on an authored complex floor', () => {
  it('lays deck, bulkhead and pillar art, and the bulkhead caps, in place of the floor and wall art', () => {
    const { s, sprites } = pack()
    const view = new TilemapView()
    view.build(authored(COMPLEX).level, createArt(fakeRenderer, sprites))
    expect(drawnFrom(view, s.deck)).toBe(count(ROWS, '.'))
    expect(drawnFrom(view, s.pillar)).toBe(2)
    expect(drawnFrom(view, s.bulkhead)).toBe(count(ROWS, '#') - 2)
    expect(drawnFrom(view, s.hull)).toBe(count(ROWS, 'H'))
    expect(drawnFrom(view, [...s.floor, ...s.wall])).toBe(0)
    expect(drawnFrom(view, [s.bulkheadCaps.edge, s.bulkheadCaps.inner])).toBeGreaterThan(0)
    expect(drawnFrom(view, [s.wallCaps.edge, s.wallCaps.inner])).toBe(0)
    // A pillar stands free, so it caps all four edges.
    const pillarCaps = new TilemapView()
    pillarCaps.build(
      worldFromState({ level: levelFromJson({ rows: ['.....', '..#..', '.....'], complex: COMPLEX }) }).level,
      createArt(fakeRenderer, sprites),
    )
    expect(drawnFrom(pillarCaps, s.pillar)).toBe(1)
    expect(drawnFrom(pillarCaps, [s.bulkheadCaps.edge])).toBe(4)
  })

  it('the same level text without `complex` draws the plain floor and wall art', () => {
    const { s, sprites } = pack()
    const view = new TilemapView()
    view.build(authored(undefined).level, createArt(fakeRenderer, sprites))
    expect(drawnFrom(view, s.floor)).toBe(count(ROWS, '.'))
    expect(drawnFrom(view, s.wall)).toBe(count(ROWS, '#'))
    expect(drawnFrom(view, [...s.deck, ...s.bulkhead, ...s.pillar])).toBe(0)
    expect(drawnFrom(view, [s.bulkheadCaps.edge, s.bulkheadCaps.inner])).toBe(0)
  })
})

describe('EntityViews on an authored complex floor', () => {
  const props = () => ({
    door: new Texture(),
    open: new Texture(),
    locked: new Texture(),
    generator: new Texture(),
    tank: new Texture(),
    tv: new Texture(),
    barrel: new Texture(),
  })

  const stage = (complex: ComplexInfo | undefined) => {
    const p = props()
    const w = authored(complex)
    const door = makeEntity('door', 'door', 4.5, 1.5, 0.5)
    door.door = { open: false, locked: false, lockLevel: 0 }
    addEntity(w, door)
    spawnObject(w, 'generator', 1, 3)
    spawnObject(w, 'barrel', 7, 3)
    const art = createArt(fakeRenderer, {
      props: {
        'bulkhead-door': p.door,
        'bulkhead-door-open': p.open,
        'bulkhead-door-locked': p.locked,
        generator: p.generator,
        'coolant-tank': p.tank,
        tv: p.tv,
        barrel: p.barrel,
      },
    })
    const views = new EntityViews(art)
    views.setIndoor(isIndoorLevel(w.level))
    const drawn = (): Texture[] => {
      views.update(w.entities, 0, w.tick, w.floor)
      return views.root.children.map((c) => (c as Sprite).texture)
    }
    return { p, door, drawn }
  }

  it('draws the indoor door, generator and coolant tank, and swaps door art with door state', () => {
    const { p, door, drawn } = stage(COMPLEX)
    expect(drawn()).toEqual(expect.arrayContaining([p.door, p.generator, p.tank]))
    expect(drawn()).not.toEqual(expect.arrayContaining([p.tv]))
    door.door!.open = true
    expect(drawn()).toContain(p.open)
    expect(drawn()).not.toContain(p.door)
    door.door!.open = false
    door.door!.locked = true
    expect(drawn()).toContain(p.locked)
  })

  it('outdoors the same entities draw the plain art', () => {
    const { p, drawn } = stage(undefined)
    const textures = drawn()
    expect(textures).toEqual(expect.arrayContaining([p.tv, p.barrel]))
    for (const t of [p.door, p.open, p.locked, p.generator, p.tank]) expect(textures).not.toContain(t)
  })
})
