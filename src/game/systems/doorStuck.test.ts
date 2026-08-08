// A closed door's tile is SOLID to the collision resolver, and `moveAndCollide`
// only ever commits a position whose whole circle fits. So a body caught inside
// that tile fails the fit test in every direction and is immobile FOREVER — no
// input, knockback or roll frees it. One press of E while stood in your own
// doorway was enough to brick a character ("characters get stuck in doors").
//
// The engine must therefore never create that state: a door refuses to close
// while a body occupies its doorway. These tests drive the REAL interaction and
// movement systems and assert on displacement, not on internals.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { interactionSystem } from './interaction'
import { movementSystem } from './movement'

const inputs = (...pairs: [number, InputCmd][]): Map<number, InputCmd> => new Map(pairs)
const interactCmd = (): InputCmd => ({ ...emptyInput(), interact: true })
const moveCmd = (moveX: number, moveY: number): InputCmd => ({ ...emptyInput(), moveX, moveY })

/** interactionSystem never moves anyone, but a test that places a body by hand
 * must sync prevPos so the pick-channel drift check sees a standing target. */
const settle = (e: Entity): void => {
  e.prevPos.x = e.pos.x
  e.prevPos.y = e.pos.y
}

/** An OPEN, unlocked door at the centre of tile (20,20) in a level with nothing
 * else solid — so the only thing that can ever immobilize a body here is the door. */
const openDoorAt2020 = (w: World): Entity => {
  w.level.solid.fill(0)
  const d = addEntity(w, makeEntity('door', 'door', 20.5, 20.5, 0.5))
  d.door = { open: true, locked: false, lockLevel: 0 }
  d.interact = { verb: 'open', range: 1.3 }
  return d
}

const npcAt = (w: World, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, y, 0.35))
  e.health = { hp: 40, max: 40, iframes: 0 }
  e.speed = 4
  return e
}

/** Distance travelled after driving `cmd` through the real movement system. */
const walk = (w: World, p: Entity, cmd: InputCmd, ticks: number): number => {
  const x0 = p.pos.x
  const y0 = p.pos.y
  for (let i = 0; i < ticks; i++) movementSystem(w, inputs([p.playerCtl!.playerId, cmd]))
  return Math.hypot(p.pos.x - x0, p.pos.y - y0)
}

describe('a door never shuts on the body standing in its doorway', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('REGRESSION: pressing interact while stood in the doorway does not shut the door on yourself', () => {
    const d = openDoorAt2020(w)
    const p = spawnPlayer(w, 0, 20.5, 20.5)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(d.door!.open).toBe(true)
    expect(w.events).toContainEqual({ type: 'doorBlocked', entityId: d.id, byId: p.id })
  })

  it('REGRESSION: and the character can still walk out afterwards (this was 0 displacement, forever)', () => {
    openDoorAt2020(w)
    const p = spawnPlayer(w, 0, 20.5, 20.5)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    // 30 ticks = 1s of full-speed input, in every direction. Pre-fix every one of
    // these was EXACTLY zero — the definition of stuck.
    expect(walk(w, p, moveCmd(1, 0), 30)).toBeGreaterThan(1)
    expect(walk(w, p, moveCmd(-1, 0), 30)).toBeGreaterThan(1)
    expect(walk(w, p, moveCmd(0, 1), 30)).toBeGreaterThan(1)
    expect(walk(w, p, moveCmd(0, -1), 30)).toBeGreaterThan(1)
  })

  it('REGRESSION: a teammate cannot shut the door on you either (the co-op way to get bricked)', () => {
    const d = openDoorAt2020(w)
    const trapped = spawnPlayer(w, 0, 20.5, 20.5)
    const presser = spawnPlayer(w, 1, 19.5, 20.5) // clear of the doorway, door in reach
    settle(trapped)
    settle(presser)
    interactionSystem(w, inputs([1, interactCmd()]))
    expect(d.door!.open).toBe(true)
    expect(w.events).toContainEqual({ type: 'doorBlocked', entityId: d.id, byId: trapped.id })
    expect(walk(w, trapped, moveCmd(1, 0), 30)).toBeGreaterThan(1)
  })

  it('REGRESSION: an NPC in the doorway blocks the close too — an entombed enemy is just as broken', () => {
    const d = openDoorAt2020(w)
    const p = spawnPlayer(w, 0, 19.5, 20.5)
    settle(p)
    const n = npcAt(w, 20.5, 20.5)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(d.door!.open).toBe(true)
    expect(w.events).toContainEqual({ type: 'doorBlocked', entityId: d.id, byId: n.id })
  })

  it('a CLEAR doorway still closes normally — the guard must not break ordinary doors', () => {
    const d = openDoorAt2020(w)
    const p = spawnPlayer(w, 0, 19.5, 20.5) // circle spans 19.15..19.85: clear of tile 20
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(d.door!.open).toBe(false)
    expect(w.events).toContainEqual({ type: 'doorToggle', entityId: d.id, open: false })
  })

  it('ADVERSARIAL: the occupancy test is EXACTLY the collision geometry, down to the boundary', () => {
    // Player radius 0.35, doorway tile spans x 20..21, so the overlap threshold is
    // a centre at exactly 20 - 0.35 = 19.65: there the circle only TOUCHES x=20 and
    // the test is a strict `<`, so the resolver would never trap it and the door may
    // shut. One hundredth nearer (19.66) it genuinely overlaps the tile and would be
    // entombed, so the door must refuse. Any looser predicate re-opens the bug; any
    // tighter one makes doors randomly un-closable.
    for (const [x, expectClosed] of [
      [19.65, true],
      [19.66, false],
    ] as const) {
      const world = createWorld(1, 1)
      const d = openDoorAt2020(world)
      const p = spawnPlayer(world, 0, x, 20.5)
      expect(p.radius).toBe(0.35)
      settle(p)
      interactionSystem(world, inputs([0, interactCmd()]))
      expect(d.door!.open).toBe(!expectClosed)
    }
  })

  it('a CORPSE in the doorway does not block the close — only bodies that still walk', () => {
    const d = openDoorAt2020(w)
    const p = spawnPlayer(w, 0, 19.5, 20.5)
    settle(p)
    const n = npcAt(w, 20.5, 20.5)
    n.dead = true
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(d.door!.open).toBe(false)
  })

  it('OPENING is never refused: a body wedged in a shut doorway can always be let back out', () => {
    // The recovery path. Even if some future code path does shut a door on someone,
    // a press of E must free them rather than being refused as "blocked".
    const d = openDoorAt2020(w)
    d.door!.open = false
    const p = spawnPlayer(w, 0, 20.5, 20.5) // wedged inside the shut door's tile
    settle(p)
    expect(walk(w, p, moveCmd(1, 0), 30)).toBe(0) // confirms the trap is real
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(d.door!.open).toBe(true)
    expect(walk(w, p, moveCmd(1, 0), 30)).toBeGreaterThan(1)
  })
})
