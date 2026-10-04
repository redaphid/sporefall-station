// A keycard opens one gate on the floor it was found on. Taking the exit to the
// next floor must leave it behind: a stale card is clutter nobody can use, and
// two floors' cards can share a name ("Essence lab keycard") with different ids.

import { describe, expect, it } from 'vitest'
import { itemClass } from '../data/items'
import { makeEntity, type Entity } from '../entity'
import { levelFromJson } from '../levelgen/levelText'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { runTicks } from '../testkit'
import type { InputCmd } from '../types'
import { addEntity, createWorld, worldFromState, type World } from '../world'
import { activeStack } from './inventory'
import { setupFloor } from './missions'

const isKeycard = (itemId: string): boolean => itemId === 'keycard' || itemId.startsWith('keycard.')

const dropPickup = (w: World, itemId: string, qty: number, x: number, y: number): Entity => {
  const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
  e.pickup = { itemId, qty }
  return addEntity(w, e)
}

const itemIds = (p: Entity): string[] => p.loadout!.inventory.map((s) => s.itemId)

// Row 1 is the walker's lane: a keycard, then a grenade, then the exit. The
// guest stands in row 2 on two cards from two different wings.
const CORRIDOR = [
  '############',
  '#@........E#',
  '#..........#',
  '############',
]

describe('keycards stay on their floor', () => {
  it('a player who picks up a keycard and takes the exit arrives without it, keeping the gun and the held grenade', () => {
    const w = worldFromState({ level: levelFromJson({ rows: CORRIDOR }) })
    const walker = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const guest = spawnPlayer(w, 1, 2.5, 2.5)
    dropPickup(w, 'keycard.wing3.essence_lab', 1, 4.5, 1.5)
    dropPickup(w, 'grenade', 2, 6.5, 1.5)
    dropPickup(w, 'keycard.wing3.essence_lab', 1, 2.5, 2.5)
    dropPickup(w, 'keycard.wing7.reactor', 1, 2.5, 2.5)

    const walk = (extra: Partial<InputCmd> = {}): World => runTicks(w, new Map([[0, { moveX: 1, ...extra }]]), 1)
    for (let t = 0; t < 120 && !itemIds(walker).includes('grenade'); t++) walk()
    expect(itemIds(walker)).toEqual(['pistol', 'keycard.wing3.essence_lab', 'grenade'])
    expect(itemIds(guest)).toEqual(['pistol', 'keycard.wing3.essence_lab', 'keycard.wing7.reactor'])

    walk({ hotbar: 2 })
    expect(activeStack(walker)?.itemId).toBe('grenade')

    for (let t = 0; t < 120 && w.floor === 1; t++) walk()
    expect(w.floor).toBe(2)

    expect(itemIds(walker)).toEqual(['pistol', 'grenade'])
    expect(activeStack(walker)).toEqual({ itemId: 'grenade', qty: 2 })
    expect(itemIds(guest)).toEqual(['pistol'])
    expect(activeStack(guest)?.itemId).toBe('pistol')
  })

  it('the briefcase goes too: no key-class item survives the exit', () => {
    const w = worldFromState({ level: levelFromJson({ rows: CORRIDOR }) })
    const p = spawnPlayer(w, 0, 9.5, 1.5)
    p.loadout!.inventory.push({ itemId: 'briefcase', qty: 1 }, { itemId: 'keycard', qty: 1 }, { itemId: 'grenade', qty: 1 })
    p.loadout!.activeSlot = 3
    for (let t = 0; t < 60 && w.floor === 1; t++) runTicks(w, new Map([[0, { moveX: 1 }]]), 1)
    expect(w.floor).toBe(2)
    expect(itemIds(p).filter((id) => itemClass(id) === 'key')).toEqual([])
    expect(activeStack(p)?.itemId).toBe('grenade')
  })
})

// Seeds 1..40 put a keycard gate on enough floors to matter (the count is
// asserted below so the sweep cannot pass by finding nothing to carry).
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)
const LAST_FLOOR = 6

describe('generator sweep: no player arrives on a floor holding an earlier floor\'s keycard', () => {
  it(`seeds ${SEEDS[0]}..${SEEDS[SEEDS.length - 1]}, floors 2..${LAST_FLOOR}, host and guest`, () => {
    const stale: string[] = []
    let carried = 0
    for (const seed of SEEDS) {
      const w = createWorld(seed, 1)
      populateWorld(w)
      setupFloor(w)
      const players = [0, 1].map((slot) => spawnPlayer(w, slot, w.level.spawn.x, w.level.spawn.y))
      while (w.floor < LAST_FLOOR) {
        const cards = w.entities.filter((e) => e.pickup && !e.dead && isKeycard(e.pickup.itemId))
        for (const card of cards) {
          const p = players[carried % players.length]
          p.pos = { ...card.pos }
          p.prevPos = { ...card.pos }
          runTicks(w, new Map(), 1)
          expect(card.dead, `seed ${seed} floor ${w.floor}: ${card.pickup!.itemId} collected`).toBe(true)
          carried++
        }
        const from = w.floor
        const exit = w.mission.extractPoint ?? w.level.exit
        w.mission.exitUnlocked = true
        players[0].pos = { x: exit.x + 0.5, y: exit.y + 0.5 }
        players[0].prevPos = { ...players[0].pos }
        runTicks(w, new Map(), 1)
        expect(w.floor, `seed ${seed}: exit on floor ${from} leads down`).toBe(from + 1)
        for (const p of players) {
          const held = itemIds(p).filter(isKeycard)
          if (held.length) stale.push(`seed ${seed} floor ${w.floor} slot ${p.playerCtl!.playerId}: ${held.join(', ')}`)
        }
      }
    }
    expect(carried).toBeGreaterThan(20)
    expect(stale).toEqual([])
  }, 120_000)
})
