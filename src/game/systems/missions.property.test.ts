// Property sweep for the mission-target chain, across every levelgen archetype
// (classic BSP city, corridor spines, courtyard compounds, vaults, bunkers).
// Guards the invariants that make the HUD's 🎯 marker meaningful:
//   - the target entity EXISTS the moment a floor starts,
//   - it sits INSIDE the designated building — inside its explicit
//     objectiveRoom — on a walkable Floor tile,
//   - it is REACHABLE on foot from the spawn (tiles only; door locks are
//     pickable/breakable game content, not walls),
//   - consuming the target completes the mission and unlocks the exit (the
//     marker chain then hands over to the exit row/compass),
//   - the objectiveRoom contract is designated for EVERY building, so mission
//     placement never falls back to rooms-array-order magic.
// Plus a pinned regression table: the objectiveRoom refactor (explicit contract
// replacing "last room in the array") must keep every placement byte-identical
// — floor 1 especially, whose layout+demos are frozen.
import { describe, expect, it } from 'vitest'
import { isWallTile, Tile, tileAt } from '../levelgen/level'
import { populateWorld } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { setupFloor } from './missions'

const SEEDS = 100
const FLOORS = [1, 2, 3]

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

/** BFS over non-wall tiles from the spawn — the same walkability the sim uses
 * (door tiles are Floor; door entities are openable/pickable, not terrain). */
const reachableFrom = (w: World): Uint8Array => {
  const { w: lw, h: lh } = w.level
  const seen = new Uint8Array(lw * lh)
  const q = [Math.floor(w.level.spawn.y) * lw + Math.floor(w.level.spawn.x)]
  seen[q[0]] = 1
  while (q.length > 0) {
    const i = q.pop()!
    const x = i % lw
    const y = (i / lw) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue
      const ni = ny * lw + nx
      if (seen[ni] || isWallTile(tileAt(w.level, nx, ny))) continue
      seen[ni] = 1
      q.push(ni)
    }
  }
  return seen
}

describe(`mission target invariants — ${SEEDS} seeds × floors ${FLOORS.join(',')}`, () => {
  it('target exists, sits on Floor inside the designated building’s objectiveRoom, and is reachable', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const floor of FLOORS) {
        const w = buildFloor(seed, floor)
        const ctx = `seed=${seed} floor=${floor}`
        if (w.mission.template === 'reach') continue

        // The target entity exists at floor start.
        const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
        expect(target, `${ctx}: mission target entity missing`).toBeTruthy()
        if (!target) continue

        // The designated building exists and the target is inside it.
        const b = w.level.buildings[w.mission.targetBuilding ?? -1]
        expect(b, `${ctx}: targetBuilding index invalid`).toBeTruthy()
        if (!b) continue
        const tx = Math.floor(target.pos.x)
        const ty = Math.floor(target.pos.y)
        expect(
          tx >= b.rect.x && tx < b.rect.x + b.rect.w && ty >= b.rect.y && ty < b.rect.y + b.rect.h,
          `${ctx}: target (${target.pos.x},${target.pos.y}) outside building [${b.rect.x},${b.rect.y} ${b.rect.w}x${b.rect.h}] poi=${b.poi ?? 'plain'}`,
        ).toBe(true)

        // …specifically inside the building's EXPLICIT objective room.
        const r = b.objectiveRoom
        expect(r, `${ctx}: target building has no objectiveRoom (poi=${b.poi ?? 'plain'})`).toBeTruthy()
        if (r) {
          expect(
            tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h,
            `${ctx}: target (${tx},${ty}) not in objectiveRoom [${r.x},${r.y} ${r.w}x${r.h}] poi=${b.poi ?? 'plain'}`,
          ).toBe(true)
        }

        // On a real Floor tile — never a wall, street, or courtyard pit.
        expect(tileAt(w.level, tx, ty), `${ctx}: target tile not Floor (poi=${b.poi ?? 'plain'})`).toBe(Tile.Floor)

        // Reachable on foot from the spawn.
        const seen = reachableFrom(w)
        expect(seen[ty * w.level.w + tx], `${ctx}: target unreachable from spawn`).toBe(1)
      }
    }
  })

  it('every building on every floor designates an objectiveRoom with positive area inside its rect', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const floor of FLOORS) {
        const w = createWorld(seed, floor)
        for (const [i, b] of w.level.buildings.entries()) {
          const ctx = `seed=${seed} floor=${floor} building=${i} poi=${b.poi ?? 'plain'}`
          expect(b.objectiveRoom, `${ctx}: no objectiveRoom designated`).toBeTruthy()
          const r = b.objectiveRoom!
          expect(r.w > 0 && r.h > 0, `${ctx}: degenerate objectiveRoom ${r.w}x${r.h}`).toBe(true)
          expect(
            r.x >= b.rect.x && r.y >= b.rect.y && r.x + r.w <= b.rect.x + b.rect.w && r.y + r.h <= b.rect.y + b.rect.h,
            `${ctx}: objectiveRoom [${r.x},${r.y} ${r.w}x${r.h}] escapes rect [${b.rect.x},${b.rect.y} ${b.rect.w}x${b.rect.h}]`,
          ).toBe(true)
          // The room's centre tile — where missions drop the target — is Floor.
          const cx = Math.floor(r.x + r.w / 2)
          const cy = Math.floor(r.y + r.h / 2)
          expect(tileAt(w.level, cx, cy), `${ctx}: objectiveRoom centre (${cx},${cy}) is not Floor`).toBe(Tile.Floor)
        }
      }
    }
  })

  it('consuming the target completes the mission and unlocks the exit (marker hands over to the exit)', () => {
    for (const seed of [1, 2, 3, 7, 12, 23, 42]) {
      const w = buildFloor(seed, 1)
      if (w.mission.template === 'reach') continue
      const target = w.byId.get(w.mission.targetEntityId!)!
      if (w.mission.template === 'steal') {
        // Hand the briefcase to a synthetic player and drop the pickup entity.
        const p = { ...target, id: w.nextId++, kind: 'player' as const }
        // Real path: pickup transfers the item, entity despawns. Emulate the
        // post-pickup state exactly: player holds briefcase, item entity gone.
        w.entities = w.entities.filter((e) => e !== target)
        w.byId.delete(target.id)
        p.pickup = undefined
        p.playerCtl = {
          playerId: 0,
          cash: 0,
          crimeUntilTick: 0,
        } as never
        p.loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 } as never
        w.entities.push(p as never)
        w.byId.set(p.id, p as never)
      } else {
        target.dead = true
      }
      tickWorld(w, new Map([[0, emptyInput()]]))
      expect(w.mission.complete, `seed=${seed}: mission did not complete after target consumed`).toBe(true)
      expect(w.mission.exitUnlocked, `seed=${seed}: exit did not unlock`).toBe(true)
      // The exit tile is real and marked — the exit compass/row has something to point at.
      expect(tileAt(w.level, w.level.exit.x, w.level.exit.y)).toBe(Tile.Exit)
    }
  })
})

// Pinned pre-refactor placements (captured on main before objectiveRoom
// existed, when missions read rooms[rooms.length-1]). The explicit-contract
// refactor MUST be placement-preserving — floor 1 doubly so (frozen layout +
// scripted demos replay on it).
const PINNED: { seed: number; floor: number; tpl: string; bld: number; pos: [number, number] }[] = [
  { seed: 1, floor: 1, tpl: 'assassinate', bld: 7, pos: [57, 57] },
  { seed: 1, floor: 2, tpl: 'steal', bld: 12, pos: [7, 56.5] },
  { seed: 1, floor: 3, tpl: 'steal', bld: 7, pos: [57, 53.5] },
  { seed: 1, floor: 4, tpl: 'steal', bld: 9, pos: [46.5, 44.5] },
  { seed: 2, floor: 1, tpl: 'steal', bld: 5, pos: [55.5, 58] },
  { seed: 2, floor: 2, tpl: 'steal', bld: 10, pos: [11, 56.5] },
  { seed: 2, floor: 3, tpl: 'assassinate', bld: 1, pos: [59, 19] },
  { seed: 2, floor: 4, tpl: 'steal', bld: 10, pos: [39, 57] },
  { seed: 3, floor: 1, tpl: 'steal', bld: 11, pos: [57, 56.5] },
  { seed: 3, floor: 2, tpl: 'assassinate', bld: 12, pos: [56, 57] },
  { seed: 3, floor: 3, tpl: 'assassinate', bld: 7, pos: [56, 55] },
  { seed: 3, floor: 4, tpl: 'assassinate', bld: 12, pos: [57.5, 57] },
  { seed: 4, floor: 1, tpl: 'steal', bld: 6, pos: [57.5, 27] },
  { seed: 4, floor: 2, tpl: 'assassinate', bld: 4, pos: [44, 45.5] },
  { seed: 4, floor: 3, tpl: 'assassinate', bld: 0, pos: [17, 15] },
  { seed: 4, floor: 4, tpl: 'steal', bld: 0, pos: [8.5, 8] },
  { seed: 5, floor: 1, tpl: 'assassinate', bld: 6, pos: [56, 44.5] },
  { seed: 5, floor: 2, tpl: 'assassinate', bld: 2, pos: [57.5, 6.5] },
  { seed: 5, floor: 3, tpl: 'steal', bld: 6, pos: [59, 59] },
  { seed: 5, floor: 4, tpl: 'assassinate', bld: 11, pos: [23, 58] },
  { seed: 6, floor: 1, tpl: 'assassinate', bld: 8, pos: [57.5, 56.5] },
  { seed: 6, floor: 2, tpl: 'assassinate', bld: 10, pos: [55.5, 55] },
  { seed: 6, floor: 3, tpl: 'assassinate', bld: 1, pos: [59, 19] },
  { seed: 6, floor: 4, tpl: 'steal', bld: 0, pos: [7.5, 7] },
  { seed: 7, floor: 1, tpl: 'steal', bld: 6, pos: [58, 58] },
  { seed: 7, floor: 2, tpl: 'steal', bld: 5, pos: [22, 57] },
  { seed: 7, floor: 3, tpl: 'steal', bld: 4, pos: [31.5, 53] },
  { seed: 7, floor: 4, tpl: 'assassinate', bld: 10, pos: [56.5, 46.5] },
  { seed: 8, floor: 1, tpl: 'assassinate', bld: 7, pos: [56, 58] },
  { seed: 8, floor: 2, tpl: 'steal', bld: 2, pos: [57.5, 11] },
  { seed: 8, floor: 3, tpl: 'steal', bld: 2, pos: [56, 15] },
  { seed: 8, floor: 4, tpl: 'assassinate', bld: 4, pos: [12, 56.5] },
  { seed: 9, floor: 1, tpl: 'assassinate', bld: 8, pos: [58, 56.5] },
  { seed: 9, floor: 2, tpl: 'steal', bld: 3, pos: [56, 9.5] },
  { seed: 9, floor: 3, tpl: 'assassinate', bld: 6, pos: [12, 53] },
  { seed: 9, floor: 4, tpl: 'assassinate', bld: 9, pos: [57, 57] },
  { seed: 10, floor: 1, tpl: 'assassinate', bld: 10, pos: [56.5, 56.5] },
  { seed: 10, floor: 2, tpl: 'assassinate', bld: 0, pos: [32, 8] },
  { seed: 10, floor: 3, tpl: 'assassinate', bld: 2, pos: [53.5, 12] },
  { seed: 10, floor: 4, tpl: 'steal', bld: 7, pos: [11.5, 56] },
  { seed: 11, floor: 1, tpl: 'assassinate', bld: 8, pos: [55.5, 56] },
  { seed: 11, floor: 2, tpl: 'steal', bld: 3, pos: [18, 57.5] },
  { seed: 11, floor: 3, tpl: 'steal', bld: 5, pos: [20, 59] },
  { seed: 11, floor: 4, tpl: 'assassinate', bld: 0, pos: [57.5, 11] },
  { seed: 12, floor: 1, tpl: 'steal', bld: 13, pos: [56.5, 56] },
  { seed: 12, floor: 2, tpl: 'steal', bld: 0, pos: [8, 7.5] },
  { seed: 12, floor: 3, tpl: 'steal', bld: 6, pos: [53, 52.5] },
  { seed: 12, floor: 4, tpl: 'assassinate', bld: 9, pos: [57, 56] },
]

describe('objectiveRoom refactor is placement-preserving (pinned pre-refactor table)', () => {
  it('reproduces every pinned mission placement byte-identically', () => {
    for (const row of PINNED) {
      const w = buildFloor(row.seed, row.floor)
      const ctx = `seed=${row.seed} floor=${row.floor}`
      expect(w.mission.template, ctx).toBe(row.tpl)
      expect(w.mission.targetBuilding, ctx).toBe(row.bld)
      const t = w.byId.get(w.mission.targetEntityId!)!
      expect([t.pos.x, t.pos.y], ctx).toEqual(row.pos)
    }
  })
})
