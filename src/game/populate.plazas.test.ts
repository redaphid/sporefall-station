// A district dresses its open squares (populate.dressPlazas): Still Row stands
// barrel and crate stacks round its sump, the Culture Beds plant rows of
// planters on the moss. Authored squares, so no generator change moves them.

import { describe, expect, it } from 'vitest'
import { levelFromJson } from './levelgen/levelText'
import { createWorld, worldFromState, type World } from './world'
import { populateWorld } from './populate'
import { serializeWorld } from './serialize'
import { generateLevel } from './levelgen/generate'
import { themeNamed, type ThemeName } from './levelgen/level'

const SIZE = 20
const SQUARE = { x: 3, y: 3, w: 12, h: 12 }

/** A walled yard holding one open square: paved ring, district heart. */
const square = (theme: ThemeName, heartGlyph: string, seed = 1): World => {
  const rows: string[] = []
  for (let y = 0; y < SIZE; y++) {
    let row = ''
    for (let x = 0; x < SIZE; x++) {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1
      const inSq = x >= SQUARE.x && y >= SQUARE.y && x < SQUARE.x + SQUARE.w && y < SQUARE.y + SQUARE.h
      const heart = x >= SQUARE.x + 2 && y >= SQUARE.y + 2 && x < SQUARE.x + SQUARE.w - 2 && y < SQUARE.y + SQUARE.h - 2
      row += edge ? '#' : x === 1 && y === 1 ? '@' : heart ? heartGlyph : inSq ? '-' : ':'
    }
    rows.push(row)
  }
  return worldFromState({ level: levelFromJson({ rows, theme, plazas: [SQUARE], exit: { x: SIZE - 2, y: SIZE - 2 } }), seed, floor: 2 })
}

const props = (w: World) => w.entities.filter((e) => e.kind === 'interactable')

describe('district squares', () => {
  it('Still Row stands only its own yard props, on the heart, none touching', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = square('stillworks', '~', seed)
      populateWorld(w)
      const placed = props(w)
      expect(placed.length, `seed ${seed}`).toBeGreaterThanOrEqual(3)
      const allowed = themeNamed('stillworks').plazaProps.map((p) => p.prop)
      const tiles = placed.map((e) => ({ x: Math.floor(e.pos.x), y: Math.floor(e.pos.y), a: e.archetype }))
      for (const t of tiles) {
        expect(allowed, `seed ${seed}`).toContain(t.a)
        expect(t.x >= SQUARE.x + 2 && t.x < SQUARE.x + SQUARE.w - 2, `seed ${seed} x ${t.x}`).toBe(true)
        expect(t.y >= SQUARE.y + 2 && t.y < SQUARE.y + SQUARE.h - 2, `seed ${seed} y ${t.y}`).toBe(true)
      }
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const touch = Math.abs(tiles[i].x - tiles[j].x) <= 1 && Math.abs(tiles[i].y - tiles[j].y) <= 1
          expect(touch, `seed ${seed}: ${tiles[i].a} and ${tiles[j].a} touch`).toBe(false)
        }
      }
    }
  })

  it('the Culture Beds plant planters; downtown and the slums leave the square bare', () => {
    const beds = square('culturebeds', ',')
    populateWorld(beds)
    expect(props(beds).filter((e) => e.archetype === 'plant').length).toBeGreaterThanOrEqual(3)
    for (const theme of ['downtown', 'slums'] as const) {
      const w = square(theme, ',')
      populateWorld(w)
      expect(props(w), theme).toHaveLength(0)
    }
  })

  it('a square never walls anything in: with every prop solid, the whole yard stays reachable', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const [theme, glyph] of [['stillworks', '~'], ['culturebeds', ',']] as const) {
        const w = square(theme, glyph, seed)
        populateWorld(w)
        const blocked = new Set(props(w).map((e) => Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)))
        const W = w.level.w
        const start = Math.floor(w.level.spawn.y) * W + Math.floor(w.level.spawn.x)
        const seen = new Uint8Array(w.level.tiles.length)
        const queue = [start]
        seen[start] = 1
        while (queue.length) {
          const i = queue.pop()!
          for (const n of [i + 1, i - 1, i + W, i - W]) {
            if (seen[n] || w.level.solid[n] || blocked.has(n)) continue
            seen[n] = 1
            queue.push(n)
          }
        }
        for (let i = 0; i < seen.length; i++) {
          if (w.level.solid[i] || blocked.has(i)) continue
          expect(seen[i], `seed ${seed} ${theme}: (${i % W},${Math.floor(i / W)}) cut off`).toBe(1)
        }
      }
    }
  })

  it('never stands on the spawn or the exit, even when they sit on the heart', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = square('stillworks', '~', seed)
      w.level.spawn = { x: SQUARE.x + 5.5, y: SQUARE.y + 5.5 }
      w.level.exit = { x: SQUARE.x + 6, y: SQUARE.y + 6 }
      populateWorld(w)
      for (const e of props(w)) {
        const k = `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`
        expect(k, `seed ${seed}`).not.toBe(`${SQUARE.x + 5},${SQUARE.y + 5}`)
        expect(k, `seed ${seed}`).not.toBe(`${SQUARE.x + 6},${SQUARE.y + 6}`)
      }
    }
  })

  it('is deterministic, and a level with no squares (or no district) dresses nothing', () => {
    const a = square('culturebeds', ',', 9)
    const b = square('culturebeds', ',', 9)
    populateWorld(a)
    populateWorld(b)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
    const bare = worldFromState({ level: levelFromJson({ rows: ['#####', '#@..#', '#####'], theme: 'stillworks' }) })
    populateWorld(bare)
    expect(props(bare)).toHaveLength(0)
  })

  it('generated Still Row and Culture Beds floors carry their dressing in play', () => {
    const seen = new Map<string, number>()
    for (let seed = 1; seed <= 80; seed++) {
      const level = generateLevel(seed, 2)
      if (level.theme !== 'stillworks' && level.theme !== 'culturebeds') continue
      if (!level.plazas?.length) continue
      const w = createWorld(seed, 2)
      populateWorld(w)
      const allowed = themeNamed(level.theme).plazaProps.map((p) => p.prop)
      const n = props(w).filter((e) => level.plazas!.some((r) => e.pos.x >= r.x && e.pos.y >= r.y && e.pos.x < r.x + r.w && e.pos.y < r.y + r.h)).length
      if (n > 0) seen.set(level.theme, (seen.get(level.theme) ?? 0) + 1)
      for (const e of props(w)) {
        const inSq = level.plazas.some((r) => e.pos.x >= r.x + 2 && e.pos.y >= r.y + 2 && e.pos.x < r.x + r.w - 2 && e.pos.y < r.y + r.h - 2)
        if (inSq) expect(allowed, `seed ${seed}`).toContain(e.archetype)
      }
    }
    expect(seen.get('stillworks') ?? 0).toBeGreaterThan(3)
    expect(seen.get('culturebeds') ?? 0).toBeGreaterThan(3)
  })
})
