// #87 — the verbs that had no look of their own (panic, spore blindness) get an
// overhead mark. Driven through the real `element-verbs` scenario and the real
// systems, then asserted on what the renderer model says to draw.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { populateWorld, spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { applyScenario } from '../game/scenarios'
import { playerSpawnPoint } from '../game/spawnPlacement'
import { setupFloor } from '../game/systems/missions'
import { addStatus, applyStatus, isImmobilized } from '../game/systems/statusFx'
import { runTicks } from '../game/testkit'
import { createWorld, type World } from '../game/world'
import { verbMarks } from './verbMarkers'

const stage = (seed = 7): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  expect(applyScenario(w, 'element-verbs')).toBe(true)
  return w
}

/** The five staged thugs, west to east: frozen, lit, zapped, leap landing, spore. */
const cast = (w: World): Entity[] => w.entities.filter((e) => e.archetype === 'thug').slice(-5)

const bare = (): World => createWorld(1, 1)

const marksOn = (w: World, e: Entity): string[] =>
  verbMarks(w.entities, w.tick)
    .filter((m) => m.id === e.id)
    .map((m) => m.verb)

describe('element-verbs stage', () => {
  it('shows every verb at once: held, panicking, jumped, blind', () => {
    const w = stage()
    const [held, lit, zapped, landing, choking] = cast(w)
    runTicks(w, new Map(), 2)
    expect(isImmobilized(held!)).toBe(true)
    expect(isImmobilized(zapped!)).toBe(true)
    expect(isImmobilized(landing!)).toBe(true) // the shock leapt
    expect(marksOn(w, lit!)).toEqual(['panic'])
    expect(marksOn(w, choking!)).toEqual(['blind'])
    // Frozen and electrified read on the body (shader + tint); no extra mark.
    expect(marksOn(w, held!)).toEqual([])
    expect(marksOn(w, zapped!)).toEqual([])
  })

  it('the marked thug is really running: it ends its panic farther from the player', () => {
    const w = stage()
    const lit = cast(w)[1]!
    const p = w.entities.find((e) => e.playerCtl)!
    const d = (): number => Math.hypot(lit.pos.x - p.pos.x, lit.pos.y - p.pos.y)
    const d0 = d()
    runTicks(w, new Map(), 55)
    expect(marksOn(w, lit)).toEqual(['panic'])
    expect(d()).toBeGreaterThan(d0 + 2)
  })

  it('the panic mark clears when the panic does, though the body still burns', () => {
    const w = stage()
    const lit = cast(w)[1]!
    runTicks(w, new Map(), 70)
    expect(lit.fx?.burning).toBeDefined()
    expect(marksOn(w, lit)).toEqual([])
  })

  it('the blind mark clears when the spore does', () => {
    const w = bare()
    const e = spawnNpc(w, 'thug', 10.5, 10.5)
    addStatus(w, e, 'spore', 30)
    expect(marksOn(w, e)).toEqual(['blind'])
    runTicks(w, new Map(), 31)
    expect(e.fx?.spore).toBeUndefined()
    expect(marksOn(w, e)).toEqual([])
  })
})

describe('verbMarks', () => {
  it('a spore-immune body breathing spore is not marked blind', () => {
    const w = bare()
    const e = spawnNpc(w, 'thug', 10.5, 10.5)
    e.resist = { ...e.resist, spore: 0 }
    addStatus(w, e, 'spore', 150)
    expect(verbMarks(w.entities, w.tick)).toEqual([])
  })

  it('a burning body that never panicked (a boss) wears no panic mark', () => {
    const w = bare()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)
    applyStatus(w, boss, 'burning', 600)
    expect(boss.fx?.burning).toBeDefined()
    expect(verbMarks(w.entities, w.tick)).toEqual([])
  })

  it('the dead, players and ai-less props are never marked', () => {
    const w = bare()
    const dead = spawnNpc(w, 'thug', 10.5, 10.5)
    applyStatus(w, dead, 'burning', 600)
    addStatus(w, dead, 'spore', 150)
    dead.dead = true
    const p = spawnPlayer(w, 0, 12.5, 10.5)
    addStatus(w, p, 'spore', 150)
    const prop = spawnNpc(w, 'thug', 14.5, 10.5)
    prop.ai = undefined
    addStatus(w, prop, 'spore', 150)
    expect(verbMarks(w.entities, w.tick)).toEqual([])
  })

  it('a burning, choking NPC wears both marks, panic first', () => {
    const w = bare()
    const e = spawnNpc(w, 'thug', 10.5, 10.5)
    addStatus(w, e, 'spore', 150)
    applyStatus(w, e, 'burning', 600)
    expect(verbMarks(w.entities, w.tick)).toEqual([
      { id: e.id, verb: 'panic' },
      { id: e.id, verb: 'blind' },
    ])
  })
})
