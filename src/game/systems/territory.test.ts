// #77 — NPC purpose & building territory (v1). Building-spawned NPCs are BOUND
// to their station module (`ai.zone`) and derive goals from it: hold their own
// room (`work`), and — if they belong to the objective wing — mass on the
// objective room as a garrison. An intruder inside a fighter's wing is defended
// against locally. Sets exact state (real floors + a controlled fixture), runs
// the REAL tickWorld/decide, asserts the behaviour.

import { describe, expect, it } from 'vitest'
import type { Building } from '../levelgen/level'
import { Tile, buildingAt, rectCenter } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { setupFloor } from './missions'
import { decide } from './behaviors'

/** Boot a full, real floor exactly as a run does (populate → mission setup). */
const floor = (seed: number, f = 1): World => {
  const w = createWorld(seed, f)
  populateWorld(w)
  setupFloor(w)
  return w
}

const zonedNpcs = (w: World) => w.entities.filter((e) => e.ai && !e.dead && e.ai.zone)
const allNpcs = (w: World) => w.entities.filter((e) => e.kind === 'npc' && e.ai && !e.dead)

describe('#77 territory — NPCs are bound to the module they spawn in', () => {
  it('every zoned NPC sits in the module it is bound to, with a matching role', () => {
    for (const seed of [1, 2, 3, 7, 13, 22]) {
      const w = floor(seed)
      for (const e of zonedNpcs(w)) {
        const bi = buildingAt(w.level, e.pos.x, e.pos.y)
        expect(e.ai!.zone!.building, `seed ${seed} npc ${e.id}`).toBe(bi)
        expect(e.ai!.zone!.role).toBe(w.level.buildings[bi].role)
      }
      // A populated floor binds a real cohort of residents to its modules.
      expect(zonedNpcs(w).length).toBeGreaterThanOrEqual(4)
    }
  })

  it('street-life roamers (spawned outside every building) carry no zone', () => {
    // Any NPC the lookup places outside all buildings must be an unbound roamer.
    for (const seed of [2, 3, 13]) {
      const w = floor(seed)
      const roamers = allNpcs(w).filter((e) => buildingAt(w.level, e.pos.x, e.pos.y) === -1)
      for (const e of roamers) expect(e.ai!.zone, `seed ${seed} roamer ${e.id}`).toBeUndefined()
      expect(roamers.length).toBeGreaterThanOrEqual(1) // street life exists
    }
  })
})

describe('#77 territory — residents pursue building-derived goals when quiet', () => {
  it('the great majority of zoned NPCs choose work/garrison over aimless wander', () => {
    const w = floor(2)
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 40; t++) tickWorld(w, input)
    const zoned = zonedNpcs(w)
    const derived = zoned.filter((e) => e.ai!.goal === 'work' || e.ai!.goal === 'garrison')
    expect(zoned.length).toBeGreaterThanOrEqual(6)
    expect(derived.length / zoned.length).toBeGreaterThanOrEqual(0.75)
  })
})

describe('#77 territory — the objective wing garrisons its core', () => {
  it('objective-building residents converge on the objective room; others hold their own turf', () => {
    const w = floor(2)
    const tb = w.mission.targetBuilding!
    const b = w.level.buildings[tb]
    const core = rectCenter(b.objectiveRoom ?? b.rect)
    const meanDistToCore = (list: ReturnType<typeof zonedNpcs>): number =>
      list.reduce((s, e) => s + Math.hypot(e.pos.x - core.x, e.pos.y - core.y), 0) / Math.max(1, list.length)

    const objResIds = zonedNpcs(w)
      .filter((e) => e.ai!.zone!.building === tb)
      .map((e) => e.id)
    const otherResIds = zonedNpcs(w)
      .filter((e) => e.ai!.zone!.building !== tb)
      .map((e) => e.id)
    expect(objResIds.length).toBeGreaterThanOrEqual(2)
    expect(otherResIds.length).toBeGreaterThanOrEqual(2)

    const objRes = () => objResIds.map((id) => w.byId.get(id)!).filter((e) => !e.dead)
    const otherRes = () => otherResIds.map((id) => w.byId.get(id)!).filter((e) => !e.dead)
    const objBefore = meanDistToCore(objRes())
    const otherBefore = meanDistToCore(otherRes())

    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 150; t++) tickWorld(w, input)

    const objAfter = meanDistToCore(objRes())
    const otherAfter = meanDistToCore(otherRes())
    // The garrison closes on the core…
    expect(objAfter).toBeLessThan(objBefore * 0.8)
    // …while residents of OTHER wings do not drift onto the objective at all.
    expect(otherAfter).toBeGreaterThan(objAfter * 2)
    expect(Math.abs(otherAfter - otherBefore)).toBeLessThan(5)
  })
})

describe('#77 territory — a fighter defends its own wing (localized, not global)', () => {
  // Controlled fixture: a peaceful world (so the shipped `threat` drive stays
  // silent for a player-neutral cop) with one injected office module. Only
  // `defendMyWing` can turn the cop on a trespassing player — and only while the
  // player is INSIDE the wing.
  const carved = (seed: number): { w: World; cx: number; cy: number } => {
    const w = createWorld(seed, 1, 'normal', false) // peaceful
    const cx = Math.floor(w.level.w / 2)
    const cy = Math.floor(w.level.h / 2)
    for (let y = cy - 10; y <= cy + 10; y++)
      for (let x = cx - 10; x <= cx + 10; x++)
        if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
          w.level.tiles[y * w.level.w + x] = Tile.Floor
          w.level.solid[y * w.level.w + x] = 0
        }
    return { w, cx: cx + 0.5, cy: cy + 0.5 }
  }

  it('a cop turns on a player who breaches its wing, and stands down when they leave', () => {
    const { w, cx, cy } = carved(9)
    const rect = { x: Math.floor(cx) - 6, y: Math.floor(cy) - 6, w: 12, h: 12 }
    const b: Building = { rect, rooms: [rect], doors: [], role: 'office', objectiveRoom: rect }
    w.level.buildings = [b]
    w.mission = { ...w.mission, targetBuilding: 0 }

    const cop = spawnNpc(w, 'cop', cx, cy)
    cop.ai!.zone = { building: 0, role: 'office' }
    cop.ai!.sightRange = 16
    const player = spawnPlayer(w, 0, cx + 3, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }

    // Peaceful world → a player-neutral cop wouldn't otherwise fight; the breach
    // of its wing is the sole reason it engages.
    const inWing = decide(w, cop).goal
    expect(['battle', 'pursue']).toContain(inWing.code)
    expect(inWing.target).toBe(player.id)

    // Player steps OUT of the module → the garrison stands down (holds the core).
    player.pos.x = rect.x - 4
    player.prevPos.x = player.pos.x
    const outOfWing = decide(w, cop).goal
    expect(['battle', 'pursue']).not.toContain(outOfWing.code)
  })
})

describe('#77 territory — inert without a zone (regression / adversarial)', () => {
  it('a directly-spawned NPC with no zone still just wanders', () => {
    const w = createWorld(5, 1)
    const cx = Math.floor(w.level.w / 2)
    const cy = Math.floor(w.level.h / 2)
    for (let y = cy - 6; y <= cy + 6; y++)
      for (let x = cx - 6; x <= cx + 6; x++)
        if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
          w.level.tiles[y * w.level.w + x] = Tile.Floor
          w.level.solid[y * w.level.w + x] = 0
        }
    const npc = spawnNpc(w, 'civilian', cx + 0.5, cy + 0.5)
    expect(npc.ai!.zone).toBeUndefined()
    expect(decide(w, npc).goal.code).toBe('wander')
  })
})
