import { describe, expect, it } from 'vitest'
import { NPCS } from './data/npcs'
import type { Entity } from './entity'
import { isSolidTile, rectContains } from './levelgen/level'
import type { Rect } from './levelgen/rooms'
import { populateWorld } from './populate'
import { spawnPlayer } from './player'
import { ARENAS, arenaRoom, stageArena } from './arenas'
import { applyScenario, isKnownScenario, SCENARIO_NAMES } from './scenarios'
import { playerSpawnPoint } from './spawnPlacement'
import { setupFloor } from './systems/missions'
import { expectWorldEqual, runTicks } from './testkit'
import { SIM_RATE } from './types'
import { createWorld, type World } from './world'

// The census seeds plus three with rooms 12 to 13 tiles deep, where a foe on the far wall would stand out of sight.
const SEEDS = [303, 5, 4, 2, 44, 18, 51, 10, 1, 8, 112]

const run = (seed: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  return w
}

const arena = (seed: number, name: string): { w: World; room: Rect } => {
  const w = run(seed)
  const room = arenaRoom(w)
  if (!room) throw new Error(`seed ${seed} has no room`)
  expect(applyScenario(w, name)).toBe(true)
  return { w, room }
}

const inside = (r: Rect, e: Entity): boolean => rectContains(r, Math.floor(e.pos.x), Math.floor(e.pos.y))
const cell = (e: Entity): string => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`
const foes = (w: World): Entity[] => w.entities.filter((e) => e.ai && !e.dead)
const player = (w: World): Entity => w.entities.find((e) => e.playerCtl)!

describe('arena scenarios', () => {
  const names = Object.keys(ARENAS)

  it('registers every arena as a ?scenario= name', () => {
    expect(names.length).toBeGreaterThanOrEqual(5)
    for (const name of names) {
      expect(isKnownScenario(name)).toBe(true)
      expect(SCENARIO_NAMES).toContain(name)
    }
  })

  it('names only known arenas as controls, each fielding the same cast as its control', () => {
    for (const [name, spec] of Object.entries(ARENAS)) {
      if (!spec.control) continue
      const control = ARENAS[spec.control]
      expect(control, `${name} control ${spec.control}`).toBeDefined()
      expect(spec.foes.map((f) => [f.archetype, f.count])).toEqual(control.foes.map((f) => [f.archetype, f.count]))
    }
  })

  it('picks the room with the most open floor, the same one on every call', () => {
    for (const seed of SEEDS) {
      const w = run(seed)
      const room = arenaRoom(w)!
      const open = (r: Rect): number => {
        let n = 0
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!isSolidTile(w.level, x, y)) n++
        return n
      }
      const most = Math.max(...w.level.buildings.flatMap((b) => b.rooms.map(open)))
      expect(open(room)).toBe(most)
      expect(arenaRoom(run(seed))).toEqual(room)
    }
  })

  for (const name of names) {
    describe(name, () => {
      it('builds a byte-identical world from the same seed', () => {
        expectWorldEqual(arena(303, name).w, arena(303, name).w)
      })

      it('places exactly the foes it names, inside the room, on distinct open cells', () => {
        const spec = ARENAS[name]
        for (const seed of SEEDS) {
          const { w, room } = arena(seed, name)
          const cast = foes(w)
          const want: Record<string, number> = {}
          for (const f of spec.foes) want[f.archetype] = (want[f.archetype] ?? 0) + f.count
          const got: Record<string, number> = {}
          for (const e of cast) got[e.archetype] = (got[e.archetype] ?? 0) + 1
          expect(got, `seed ${seed}`).toEqual(want)
          for (const e of cast) {
            expect(inside(room, e), `seed ${seed} ${e.archetype} at ${cell(e)}`).toBe(true)
            expect(isSolidTile(w.level, Math.floor(e.pos.x), Math.floor(e.pos.y))).toBe(false)
          }
          expect(new Set(cast.map(cell)).size).toBe(cast.length)
        }
      })

      it('applies each foe override on top of the archetype table', () => {
        const spec = ARENAS[name]
        const { w } = arena(303, name)
        for (const f of spec.foes) {
          for (const e of foes(w).filter((x) => x.archetype === f.archetype)) {
            const table = NPCS[f.archetype].resist
            expect(e.resist).toEqual(table || f.resist ? { ...table, ...f.resist } : undefined)
            expect(e.fx?.wet !== undefined).toBe(f.wet === true)
            expect(e.health).toEqual({ hp: NPCS[f.archetype].hp, max: NPCS[f.archetype].hp, iframes: 0 })
          }
        }
      })

      it('stands a full-health player with no spawn grace on an open cell, every foe 3 tiles off and inside its own sight', () => {
        for (const seed of SEEDS) {
          const { w, room } = arena(seed, name)
          const me = player(w)
          expect(inside(room, me)).toBe(true)
          expect(isSolidTile(w.level, Math.floor(me.pos.x), Math.floor(me.pos.y))).toBe(false)
          expect(me.health).toEqual({ hp: me.health!.max, max: me.health!.max, iframes: 0 })
          for (const e of foes(w)) {
            const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y)
            expect(d, `seed ${seed} ${e.archetype}`).toBeGreaterThanOrEqual(3)
            expect(d, `seed ${seed} ${e.archetype}`).toBeLessThanOrEqual(e.ai!.sightRange)
          }
        }
      })

      it('clears everything else that could join or bend the fight', () => {
        for (const seed of SEEDS) {
          const { w, room } = arena(seed, name)
          expect(w.entities.filter((e) => e.kind === 'pickup' || e.projectile || e.kind === 'fire')).toEqual([])
          expect(w.entities.filter((e) => e.kind === 'interactable' && inside(room, e))).toEqual([])
          expect(w.groups).toBeUndefined()
          expect(w.hostile).toBe(true)
          expect(w.mission.complete).toBe(true)
          expect(w.mission.exitUnlocked).toBe(false)
        }
      })
    })
  }

  it('is dangerous: a player who does nothing is downed inside 20 s in every arena on every seed', () => {
    for (const name of names) {
      for (const seed of SEEDS) {
        const { w } = arena(seed, name)
        runTicks(w, new Map(), 20 * SIM_RATE)
        const me = player(w)
        expect(me.dead || me.playerCtl!.downed !== undefined, `${name} seed ${seed}`).toBe(true)
      }
    }
  })

  it('never stacks two foes on one cell, even when the cast outnumbers the far half', () => {
    const w = run(303)
    const room = arenaRoom(w)!
    stageArena(w, { question: 'overflow', foes: [{ archetype: 'sporeling', count: 500 }] })
    const cast = foes(w)
    expect(cast.length).toBeGreaterThan(0)
    expect(cast.length).toBeLessThan(500)
    expect(new Set(cast.map(cell)).size).toBe(cast.length)
    for (const e of cast) expect(inside(room, e)).toBe(true)
  })

  it('stages a foe on the far wall of a room shallower than its sight', () => {
    const w = run(303)
    const room = arenaRoom(w)!
    const shallow = { x: room.x, y: room.y, w: 6, h: 3 }
    stageArena(w, { question: 'shallow', foes: [{ archetype: 'brute', count: 1 }] }, shallow)
    const [brute] = foes(w)
    expect(brute.pos.x - player(w).pos.x).toBe(4)
  })

  it('stages in the room it is given, even a one-row strip, and clears the whole cast', () => {
    const w = run(303)
    const room = arenaRoom(w)!
    const strip = { x: room.x, y: room.y, w: 7, h: 1 }
    stageArena(w, { question: 'strip', foes: [] }, strip)
    expect(inside(strip, player(w))).toBe(true)
    expect(foes(w)).toEqual([])
  })

  it('leaves the world alone when there is no player to stage', () => {
    const w = createWorld(303, 1)
    populateWorld(w)
    const before = w.entities.length
    stageArena(w, ARENAS['arena-brute'])
    expect(w.entities.length).toBe(before)
  })
})
