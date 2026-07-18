import { describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import { makeEntity, type Entity } from '../game/entity'

import { computeTouchLabels } from './touchLabels'

const player = (abilityCooldown = 0): Entity => {
  const p = makeEntity('player', 'player', 0, 0)
  p.combat = { weapon: 'pistol', cooldown: 0 }
  p.playerCtl = {
    playerId: 0,
    abilityCooldown,
    inventory: [],
    activeSlot: -1,
    cash: 0,
    crimeUntilTick: 0,
  }
  return p
}

const view = (self: Entity | undefined, entities: Entity[] = []): RenderView =>
  ({ entities, self } as unknown as RenderView)

const door = (open: boolean, locked = false): Entity => {
  const e = makeEntity('door', 'door.wood', 0.5, 0)
  e.interact = { verb: 'open', range: 1.3 }
  e.door = { open, locked, lockLevel: 1 }
  return e
}

describe('computeTouchLabels', () => {
  it('falls back to bare labels with no self', () => {
    expect(computeTouchLabels(view(undefined))).toEqual({
      atk: 'ATK',
      use: 'USE',
      useEnabled: false,
      spc: 'SPC',
      spcEnabled: false,
      throwEnabled: false,
    })
  })

  it('ATK shows the equipped weapon name', () => {
    expect(computeTouchLabels(view(player())).atk).toBe('Pistol')
    const bare = player()
    bare.combat = undefined
    expect(computeTouchLabels(view(bare)).atk).toBe('Fists')
  })

  it('USE is disabled and generic when nothing is in range', () => {
    const labels = computeTouchLabels(view(player()))
    expect(labels.use).toBe('USE')
    expect(labels.useEnabled).toBe(false)
  })

  it('USE reads Open/Close/Unlock from the nearest door', () => {
    expect(computeTouchLabels(view(player(), [door(false)])).use).toBe('Open')
    expect(computeTouchLabels(view(player(), [door(true)])).use).toBe('Close')
    expect(computeTouchLabels(view(player(), [door(false, true)])).use).toBe('Unlock')
    expect(computeTouchLabels(view(player(), [door(false)])).useEnabled).toBe(true)
  })

  it('USE names a usable object', () => {
    const atm = makeEntity('interactable', 'atm', 0.5, 0)
    atm.interact = { verb: 'use', range: 1.3 }
    expect(computeTouchLabels(view(player(), [atm])).use).toBe('ATM')
  })

  it('ignores interactables out of range', () => {
    const far = door(false)
    far.pos = { x: 5, y: 0 }
    expect(computeTouchLabels(view(player(), [far])).useEnabled).toBe(false)
  })

  it('THROW only enables when a throwable is carried', () => {
    expect(computeTouchLabels(view(player())).throwEnabled).toBe(false)
    const armed = player()
    armed.playerCtl!.inventory = [{ itemId: 'grenade', qty: 2 }]
    expect(computeTouchLabels(view(armed)).throwEnabled).toBe(true)
  })

  it('SPC shows the class ability and cooldown state', () => {
    const ready = computeTouchLabels(view(player(0)))
    expect(ready.spc).toBe('Grenade')
    expect(ready.spcEnabled).toBe(true)

    const cooling = computeTouchLabels(view(player(90)))
    expect(cooling.spc).toBe('Grenade 3s')
    expect(cooling.spcEnabled).toBe(false)
  })
})
