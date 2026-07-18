import { describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import { makeEntity, type Entity } from '../game/entity'
import { computeTouchLabels } from './touchLabels'

const player = (opts: { weapon?: string; cd?: number } = {}): Entity => {
  const p = makeEntity('player', 'player', 0, 0)
  p.combat = { weapon: opts.weapon ?? 'pistol', cooldown: 0 }
  p.playerCtl = {
    playerId: 0,
    abilityCooldown: opts.cd ?? 0,
    inventory: [],
    activeSlot: -1,
    cash: 0,
    crimeUntilTick: 0,
  }
  return p
}

const view = (self: Entity | undefined, entities: Entity[] = []): RenderView =>
  ({ entities, self }) as unknown as RenderView

const door = (open: boolean, locked = false, x = 0.5): Entity => {
  const e = makeEntity('door', 'door.wood', x, 0)
  e.interact = { verb: 'open', range: 1.3 }
  e.door = { open, locked, lockLevel: 1 }
  return e
}

describe('computeTouchLabels — ATK weapon fallbacks', () => {
  it('names the fists explicitly', () => {
    expect(computeTouchLabels(view(player({ weapon: 'fists' }))).atk).toBe('Fists')
  })

  it('a non-WEAPON item id (e.g. a throwable in the weapon slot) falls back to Fists', () => {
    expect(computeTouchLabels(view(player({ weapon: 'banana' }))).atk).toBe('Fists')
  })

  it('an unknown weapon id falls back to Fists rather than crashing', () => {
    expect(computeTouchLabels(view(player({ weapon: 'zzz-nope' }))).atk).toBe('Fists')
  })
})

describe('computeTouchLabels — SPC ability + cooldown edges', () => {
  it('rounds the cooldown UP to whole seconds (1 tick still reads 1s and is disabled)', () => {
    const labels = computeTouchLabels(view(player({ cd: 1 })))
    expect(labels.spc).toBe('Grenade 1s')
    expect(labels.spcEnabled).toBe(false)
  })

  it('shows the exact whole-second cooldown at a tick boundary', () => {
    expect(computeTouchLabels(view(player({ cd: 60 }))).spc).toBe('Grenade 2s')
    expect(computeTouchLabels(view(player({ cd: 61 }))).spc).toBe('Grenade 3s')
  })

  it('a ready ability (cd 0) shows just the name and is enabled', () => {
    const labels = computeTouchLabels(view(player({ cd: 0 })))
    expect(labels.spc).toBe('Grenade')
    expect(labels.spcEnabled).toBe(true)
  })
})

describe('computeTouchLabels — USE verb selection', () => {
  it('picks the label of the NEAREST interactable among several', () => {
    const self = player()
    const far = door(false, false, 1.2) // "Open"
    const near = door(true, false, 0.3) // "Close"
    expect(computeTouchLabels(view(self, [far, near])).use).toBe('Close')
  })

  it('reads Talk and Grab verbs off non-door interactables', () => {
    const talker = makeEntity('npc', 'civilian', 0.5, 0)
    talker.interact = { verb: 'talk', range: 1.3 }
    expect(computeTouchLabels(view(player(), [talker])).use).toBe('Talk')

    const loot = makeEntity('pickup', 'pickup.bat', 0.5, 0)
    loot.interact = { verb: 'pickup', range: 1.3 }
    expect(computeTouchLabels(view(player(), [loot])).use).toBe('Grab')
  })

  it('a usable OBJECT name wins over its door/verb fallback on the same entity', () => {
    const vending = makeEntity('interactable', 'vending', 0.5, 0)
    vending.interact = { verb: 'use', range: 1.3 }
    expect(computeTouchLabels(view(player(), [vending])).use).toBe('Vending Machine')
  })

  it('an unrecognized interact verb falls back to the generic Use label (still enabled)', () => {
    const thing = makeEntity('interactable', 'mystery', 0.5, 0)
    // Force a verb outside the known set to hit the switch default.
    thing.interact = { verb: 'zap' as unknown as 'use', range: 1.3 }
    const labels = computeTouchLabels(view(player(), [thing]))
    expect(labels.use).toBe('Use')
    expect(labels.useEnabled).toBe(true)
  })
})

describe('computeTouchLabels — degenerate self', () => {
  it('a self with no playerCtl still produces safe labels (weapon + ready special)', () => {
    const p = makeEntity('player', 'player', 0, 0)
    p.combat = { weapon: 'pistol', cooldown: 0 }
    const labels = computeTouchLabels(view(p))
    expect(labels.atk).toBe('Pistol')
    expect(labels.spc).toBe('Grenade')
    expect(labels.spcEnabled).toBe(true) // cd defaults to 0
  })
})
