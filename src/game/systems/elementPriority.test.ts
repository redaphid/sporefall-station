// A default-mode shot carries ONE element. Which one must follow from something
// the player did, not from the alphabet: the newest element on the weapon's mod
// list wins. The list is pickup order (applyDraftPick appends), so the element
// the player grabbed last is the element that lands.
//
// Every case sets exact world state, then runs the real sim (tickWorld) and
// asserts on the status that lands on a target.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { equipSlot, weaponStack } from './inventory'
import { hasStatus } from './statusFx'

const ELEMENT_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const ELEMENT_STATUSES = Object.values(ELEMENT_OF)

const armed = (w: World, mods?: WeaponMod[]): Entity => {
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = [{ itemId: 'pistol', qty: 99, ...(mods ? { mods } : {}) }]
  equipSlot(p, 0)
  p.facing = 0
  return p
}

const target = (w: World): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
  e.health = { hp: 400, max: 400, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const dropMod = (w: World, modId: string, at: Entity): void => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  addEntity(w, e)
}

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const shoot = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]])

/** One trigger pull through the real systems, then let the round land. */
const fireOnce = (w: World): void => {
  tickWorld(w, shoot())
  for (let i = 0; i < 10; i++) tickWorld(w, idle())
}

const landedStatuses = (e: Entity): string[] => ELEMENT_STATUSES.filter((s) => hasStatus(e, s))

const shotLands = (mods: WeaponMod[]): string[] => {
  const w = createWorld(1, 1)
  armed(w, mods)
  const t = target(w)
  fireOnce(w)
  return landedStatuses(t)
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))

describe('element priority: the newest element on the list wins', () => {
  it('Cryo picked after Tesla freezes (alphabetical order used to let Tesla win)', () => {
    expect(shotLands([{ id: 'shock', stacks: 1 }, { id: 'frost', stacks: 1 }])).toEqual(['frozen'])
  })

  it('Tesla picked after Cryo electrifies', () => {
    expect(shotLands([{ id: 'frost', stacks: 1 }, { id: 'shock', stacks: 1 }])).toEqual(['electrified'])
  })

  it('Incendiary picked after Tesla burns', () => {
    expect(shotLands([{ id: 'shock', stacks: 1 }, { id: 'incendiary', stacks: 1 }])).toEqual(['burning'])
  })

  for (const order of permutations(['frost', 'incendiary', 'shock'])) {
    it(`all three elements in order ${order.join(' > ')}: only ${order[2]} lands`, () => {
      const mods = order.map((id) => ({ id, stacks: 1 }))
      expect(shotLands(mods)).toEqual([ELEMENT_OF[order[2]]])
    })
  }

  it('non-element mods between and after the elements do not change the winner', () => {
    const mods = [
      { id: 'shock', stacks: 1 },
      { id: 'overload', stacks: 1 },
      { id: 'frost', stacks: 2 },
      { id: 'pierce', stacks: 1 },
      { id: 'rapid', stacks: 1 },
    ]
    expect(shotLands(mods)).toEqual(['frozen'])
  })

  it('a zero-stack or unknown entry after the winner is skipped, not promoted', () => {
    expect(shotLands([
      { id: 'frost', stacks: 1 },
      { id: 'shock', stacks: 0 },
      { id: 'no-such-mod', stacks: 3 },
    ])).toEqual(['frozen'])
  })

  it('real pickups: grabbing Tesla then Cryo leaves the gun freezing', () => {
    const w = createWorld(1, 1)
    const p = armed(w)
    dropMod(w, 'shock', p)
    tickWorld(w, idle())
    dropMod(w, 'frost', p)
    tickWorld(w, idle())
    expect(weaponStack(p)?.mods).toEqual([{ id: 'shock', stacks: 1 }, { id: 'frost', stacks: 1 }])
    const t = target(w)
    fireOnce(w)
    expect(landedStatuses(t)).toEqual(['frozen'])
  })

  it('the winner survives a serialize round-trip mid-run', () => {
    const w = createWorld(1, 1)
    armed(w, [{ id: 'shock', stacks: 1 }, { id: 'frost', stacks: 1 }])
    const tId = target(w).id
    tickWorld(w, idle())
    const restored = deserializeWorld(serializeWorld(w))
    fireOnce(restored)
    expect(landedStatuses(restored.byId.get(tId)!)).toEqual(['frozen'])
  })
})
