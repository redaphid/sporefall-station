// The sealed-door hint, driven by the real sim on an authored corridor: the
// player presses or walks into a sealed hatch, and the toast names what opens
// it, at most once per cooldown.

import { describe, expect, it } from 'vitest'
import { OBJECTS } from '../game/data/objects'
import { makeEntity, type Entity } from '../game/entity'
import { levelFromJson } from '../game/levelgen/levelText'
import { spawnPlayer } from '../game/player'
import { runTicks } from '../game/testkit'
import type { InputCmd } from '../game/types'
import { addEntity, worldFromState, type World } from '../game/world'
import { createSealHint, SEAL_HINT_COOLDOWN_TICKS, type SealHint } from './sealHintModel'

// A corridor with a hatch at (6,1). The player starts on the tile before it.
const ROWS = ['##########', '#.@......#', '##########']
const DOOR_X = 6

type Seal = { sealKind: 'keycard' | 'power'; overgrown?: never } | { overgrown: true; sealKind?: never } | { plain: true }

const corridor = (seal: Seal): { w: World; p: Entity; door: Entity } => {
  const w = worldFromState({ level: levelFromJson({ rows: ROWS }), floor: 3 })
  const door = makeEntity('door', 'door', DOOR_X + 0.5, 1.5, 0.5)
  door.door = { open: false, locked: true, lockLevel: 2 }
  if ('sealKind' in seal && seal.sealKind) {
    door.door.sealKind = seal.sealKind
    door.door.keyId = 'keycard.wing1'
    door.door.wing = 'wing1'
  }
  if ('overgrown' in seal) door.door.overgrown = true
  door.interact = { verb: 'open', range: 1.3 }
  addEntity(w, door)
  const p = spawnPlayer(w, 0, 5.5, 1.5)
  return { w, p, door }
}

const nameOf = (archetype: string): string => OBJECTS[archetype]?.name ?? archetype

/** Run one tick of `cmd` and return the toast the hint shows for it. */
const step = (w: World, p: Entity, hint: SealHint, cmd: Partial<InputCmd>, slot = 0): string | undefined => {
  runTicks(w, new Map([[slot, cmd]]), 1)
  return hint.update({ tick: w.tick, events: w.events, self: p, entities: w.entities })
}

const press = { interact: true }
const idle = {}

describe('sealed-door hint on a press', () => {
  it.each([
    [{ sealKind: 'keycard' } as const, 'Sealed. Find the keycard, or blast it with your Grenade special'],
    [{ sealKind: 'power' } as const, 'Sealed. Hack the Generator, or blast it with your Grenade special'],
    [{ overgrown: true } as const, 'Overgrown. Kill its Spore Node, or blast it with your Grenade special'],
  ])('%o names what opens it', (seal, text) => {
    const { w, p } = corridor(seal)
    const hint = createSealHint(nameOf)
    expect(step(w, p, hint, press)).toBe(text)
    expect(w.events.some((e) => e.type === 'sealDenied'), 'the sim really denied the press').toBe(true)
  })

  it('shows once per cooldown however often the player presses', () => {
    const { w, p } = corridor({ sealKind: 'keycard' })
    const hint = createSealHint(nameOf)
    const shown: number[] = []
    for (let t = 0; t < SEAL_HINT_COOLDOWN_TICKS * 2 + 10; t++) {
      if (step(w, p, hint, t % 2 === 0 ? press : idle)) shown.push(w.tick)
    }
    expect(shown).toEqual([1, 1 + SEAL_HINT_COOLDOWN_TICKS, 1 + 2 * SEAL_HINT_COOLDOWN_TICKS])
  })

  it("stays quiet for another player's press", () => {
    const { w, p } = corridor({ sealKind: 'keycard' })
    p.pos.x = p.prevPos.x = 2.5
    const other = spawnPlayer(w, 1, 5.5, 1.5)
    const hint = createSealHint(nameOf)
    expect(step(w, p, hint, press, 1)).toBeUndefined()
    expect(w.events.some((e) => e.type === 'sealDenied' && e.byId === other.id)).toBe(true)
  })

  it('stays quiet for a plain lock, which a press starts picking', () => {
    const { w, p } = corridor({ plain: true })
    const hint = createSealHint(nameOf)
    expect(step(w, p, hint, press)).toBeUndefined()
    expect(w.events.some((e) => e.type === 'pickStart')).toBe(true)
  })

  it('reads one frame per tick: a second frame of the same tick shows nothing new', () => {
    const { w, p } = corridor({ sealKind: 'power' })
    const hint = createSealHint(nameOf)
    expect(step(w, p, hint, press)).toBeDefined()
    expect(hint.update({ tick: w.tick, events: w.events, self: p, entities: w.entities })).toBeUndefined()
  })
})

describe('sealed-door hint on walking into the door', () => {
  const walk = { moveX: 1 }

  it('shows once on contact, not on every frame of leaning on it', () => {
    const { w, p } = corridor({ overgrown: true })
    const hint = createSealHint(nameOf)
    const shown: string[] = []
    for (let t = 0; t < SEAL_HINT_COOLDOWN_TICKS * 3; t++) {
      const text = step(w, p, hint, walk)
      if (text) shown.push(text)
    }
    expect(p.pos.x, 'the shut hatch stopped the walk').toBeLessThan(DOOR_X)
    expect(shown).toEqual(['Overgrown. Kill its Spore Node, or blast it with your Grenade special'])
  })

  it('shows again after the player steps away and comes back, once the cooldown is up', () => {
    const { w, p } = corridor({ sealKind: 'power' })
    const hint = createSealHint(nameOf)
    let shown = 0
    for (let t = 0; t < 40; t++) if (step(w, p, hint, walk)) shown++
    for (let t = 0; t < SEAL_HINT_COOLDOWN_TICKS; t++) if (step(w, p, hint, { moveX: -1 })) shown++
    for (let t = 0; t < 80; t++) if (step(w, p, hint, walk)) shown++
    expect(shown).toBe(2)
  })

  it('stays quiet while the player holds the right keycard, and the press opens it', () => {
    const { w, p, door } = corridor({ sealKind: 'keycard' })
    p.loadout!.inventory.push({ itemId: 'keycard.wing1', qty: 1 })
    const hint = createSealHint(nameOf)
    for (let t = 0; t < 40; t++) expect(step(w, p, hint, walk)).toBeUndefined()
    expect(step(w, p, hint, press)).toBeUndefined()
    expect(door.door!.open).toBe(true)
  })

  it('still hints when the keycard held is for another wing', () => {
    const { w, p } = corridor({ sealKind: 'keycard' })
    p.loadout!.inventory.push({ itemId: 'keycard.wing2', qty: 1 })
    const hint = createSealHint(nameOf)
    let text: string | undefined
    for (let t = 0; t < 40 && !text; t++) text = step(w, p, hint, walk)
    expect(text).toBe('Sealed. Find the keycard, or blast it with your Grenade special')
  })

  it('stays quiet against a plain locked door', () => {
    const { w, p } = corridor({ plain: true })
    const hint = createSealHint(nameOf)
    for (let t = 0; t < 60; t++) expect(step(w, p, hint, walk)).toBeUndefined()
    expect(p.pos.x).toBeLessThan(DOOR_X)
  })
})
