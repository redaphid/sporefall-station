// Shared bits for the crafted-save generators in this directory. Each
// generator draws its rows, stages a cast, and calls `writeSave`. The scene
// list players see is `src/scenes/registry.ts`; a save with no entry there is
// an orphan and fails `src/scenes/scenes.test.ts`.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { addEntity, type World } from '../../src/game/world'
import { makeEntity, type Entity, type WeaponMod } from '../../src/game/entity'
import { serializeWorld } from '../../src/game/serialize'

export const writeSave = (name: string, w: World): void => {
  const out = fileURLToPath(new URL(`../../src/game/__fixtures__/${name}.json`, import.meta.url))
  writeFileSync(out, JSON.stringify(serializeWorld(w), null, 2) + '\n')
  console.log(`wrote ${out} (${w.entities.length} entities)`)
}

/** Give the player one gun with these mods, in firing order. */
export const arm = (player: Entity, itemId: string, mods: WeaponMod[]): void => {
  player.loadout = { inventory: [{ itemId, qty: 1, mods }], activeSlot: 0 }
  player.combat = { weapon: itemId, cooldown: 0 }
}

/** A door on tile (tx, ty), which must be a floor tile in a one-wide gap. */
export const placeDoor = (w: World, tx: number, ty: number, door: Partial<NonNullable<Entity['door']>> = {}): Entity => {
  const d = makeEntity('door', 'door', tx + 0.5, ty + 0.5, 0.5)
  d.door = { open: false, locked: false, lockLevel: 0, ...door }
  d.interact = { verb: 'open', range: 1.3 }
  return addEntity(w, d)
}

/** A level drawn in code: fill rectangles of glyphs, then read `rows`.
 * Glyphs are the levelText legend (# wall, . floor, + tiled, ~ bog, …). */
export class Sketch {
  private readonly cells: string[][]
  constructor(w: number, h: number, fill: string) {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => fill))
  }
  /** Fill the inclusive rectangle (x0,y0)-(x1,y1). */
  fill(x0: number, y0: number, x1: number, y1: number, glyph: string): this {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.cells[y][x] = glyph
    return this
  }
  /** A walled room: `wall` on the rim, `floor` inside. */
  room(x0: number, y0: number, x1: number, y1: number, floor: string, wall = '#'): this {
    return this.fill(x0, y0, x1, y1, wall).fill(x0 + 1, y0 + 1, x1 - 1, y1 - 1, floor)
  }
  put(x: number, y: number, glyph: string): this {
    this.cells[y][x] = glyph
    return this
  }
  get rows(): string[] {
    return this.cells.map((r) => r.join(''))
  }
}
