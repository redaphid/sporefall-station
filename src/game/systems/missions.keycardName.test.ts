// A wing keycard is named after the building it opens, in the objective
// banner's words, so "Purge the Mireclaw Alpha in the essence lab" pairs with
// an "Essence lab keycard" on the hotbar.

import { describe, expect, it } from 'vitest'
import { itemName, keycardId } from '../data/items'
import { makeEntity, type Entity } from '../entity'
import type { Building } from '../levelgen/level'
import { levelFromJson } from '../levelgen/levelText'
import { addEntity, worldFromState, type World } from '../world'
import { keycardFor, setupFloor } from './missions'

// A lobby the player starts in; below it the objective lab behind one gate at (4,4).
const ROWS = ['##########', '#........#', '#.@......#', '#........#', '####.#####', '#........#', '#........#', '##########']
const BUILDINGS: Building[] = [
  { rect: { x: 0, y: 0, w: 10, h: 5 }, rooms: [{ x: 1, y: 1, w: 8, h: 3 }], doors: [{ x: 4, y: 4 }], role: 'quarters' },
  {
    rect: { x: 0, y: 4, w: 10, h: 4 },
    rooms: [{ x: 1, y: 5, w: 8, h: 2 }],
    doors: [{ x: 4, y: 4 }],
    role: 'lab',
    objectiveRoom: { x: 1, y: 5, w: 8, h: 2 },
  },
]

/** The lab's gate (building 1, so wing1) when the dice made it a keycard biolock. */
const keycardGate = (w: World): Entity | undefined =>
  w.entities.find((e) => e.door?.sealKind === 'keycard' && e.door.locked && e.door.wing === 'wing1')
const cardOn = (w: World, keyId: string): Entity | undefined => w.entities.find((e) => e.pickup?.itemId === keyId)

/** Authored floors 3 and 5 over `seeds`, keeping those whose gate the dice made a keycard biolock. */
const keycardFloors = (seeds: number, before?: (w: World) => void): World[] => {
  const out: World[] = []
  for (let seed = 1; seed <= seeds; seed++) {
    for (const floor of [3, 5]) {
      const w = worldFromState({ level: levelFromJson({ rows: ROWS, buildings: BUILDINGS }), seed, floor })
      before?.(w)
      setupFloor(w)
      if (keycardGate(w)) out.push(w)
    }
  }
  return out
}

describe('the gate keycard is named after the building it opens', () => {
  const floors = keycardFloors(40)

  it('finds keycard gates to check', () => {
    expect(floors.length).toBeGreaterThan(5)
  })

  it('names the card the way the objective banner names the building', () => {
    for (const w of floors) {
      const keyId = keycardGate(w)!.door!.keyId!
      const ctx = `seed ${w.seed} floor ${w.floor}: ${w.mission.description}`
      expect(itemName(keyId), ctx).toBe('Essence lab keycard')
      expect(w.mission.description, ctx).toContain('the essence lab')
      expect(cardOn(w, keyId), `${ctx}: the card on the floor is the one the gate wants`).toBeDefined()
    }
  })

  it('numbers a second sealed essence lab on the same floor', () => {
    const otherLab = (w: World): void => {
      const d = makeEntity('door', 'door', 8.5, 1.5, 0.5)
      d.door = { open: false, locked: true, lockLevel: 2, sealKind: 'keycard', keyId: keycardId('wing9', 'essence lab'), wing: 'wing9' }
      addEntity(w, d)
    }
    const numbered = keycardFloors(40, otherLab)
    expect(numbered.length).toBeGreaterThan(5)
    for (const w of numbered) {
      const keyId = keycardGate(w)!.door!.keyId!
      expect(itemName(keyId), `seed ${w.seed} floor ${w.floor}`).toBe('Essence lab 2 keycard')
      expect(cardOn(w, keyId), 'the numbered card is the one dropped').toBeDefined()
    }
  })
})

describe('keycardFor', () => {
  const world = (): World => worldFromState({ level: levelFromJson({ rows: ROWS, buildings: BUILDINGS }), floor: 3 })

  it('counts on past every name already taken on the floor', () => {
    const w = world()
    for (const name of ['essence lab', 'essence lab 2']) {
      const d = makeEntity('door', 'door', 8.5, 1.5, 0.5)
      d.door = { open: false, locked: true, lockLevel: 2, sealKind: 'keycard', keyId: keycardId('wing7', name) }
      addEntity(w, d)
    }
    expect(itemName(keycardFor(w, BUILDINGS[1], 'wing1'))).toBe('Essence lab 3 keycard')
  })

  it('ignores names on other kinds of seal and on cards nobody locked a door with', () => {
    const w = world()
    const power = makeEntity('door', 'door', 8.5, 1.5, 0.5)
    power.door = { open: false, locked: true, lockLevel: 2, sealKind: 'power', keyId: keycardId('wing7', 'essence lab') }
    addEntity(w, power)
    const loose = makeEntity('pickup', 'pickup.keycard', 7.5, 1.5, 0.3)
    loose.pickup = { itemId: keycardId('wing8', 'essence lab'), qty: 1 }
    addEntity(w, loose)
    expect(itemName(keycardFor(w, BUILDINGS[1], 'wing1'))).toBe('Essence lab keycard')
  })

  it('falls back to the wing number for a building with no role', () => {
    const roleless = { ...BUILDINGS[1], role: undefined } as unknown as Building
    expect(itemName(keycardFor(world(), roleless, 'wing1'))).toBe('Wing 1 keycard')
  })

  it('gives each role its banner name', () => {
    const roles = ['shop', 'clinic', 'bunker', 'lab', 'medbay', 'security'] as const
    const names = roles.map((role) => itemName(keycardFor(world(), { ...BUILDINGS[1], role }, 'wing1')))
    expect(names).toEqual([
      'Commissary keycard',
      'Med-bay keycard',
      'Reactor core keycard',
      'Essence lab keycard',
      'Infirmary keycard',
      'Security post keycard',
    ])
  })
})
