// The addMod debug verb — registry-checked, stack-capped mutation of a modded
// loadout over the channel (the AI-native payoff).

import { beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type World } from '../game/world'
import { spawnPlayer } from '../game/player'
import { equipSlot } from '../game/systems/inventory'
import { runVerb, WRITE_VERBS } from './verbs'

const armedPlayer = (w: World): number => {
  // The player starter is already a slotted, equipped pistol (a real ItemStack
  // that can carry mods) — no extra arming needed.
  const p = spawnPlayer(w, 0, 20, 20)
  equipSlot(p, 0)
  return p.id
}

describe('addMod verb', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('is registered as a WRITE verb (deferred onto the sim step)', () => {
    expect(WRITE_VERBS.has('addMod')).toBe(true)
  })

  it('adds a mod (default 1 stack) to the slotted weapon', () => {
    const id = armedPlayer(w)
    const reply = JSON.parse(runVerb(w, `addMod ${id} frost`))
    expect(reply.weapon).toBe('pistol')
    expect(reply.mods).toEqual([{ id: 'frost', stacks: 1 }])
  })

  it('stacks an existing mod and honors the explicit count', () => {
    const id = armedPlayer(w)
    runVerb(w, `addMod ${id} overload 2`)
    const reply = JSON.parse(runVerb(w, `addMod ${id} overload 1`))
    expect(reply.mods).toEqual([{ id: 'overload', stacks: 3 }])
  })

  it('clamps at the mod maxStacks', () => {
    const id = armedPlayer(w)
    const reply = JSON.parse(runVerb(w, `addMod ${id} frost 99`)) // frost maxStacks = 1
    expect(reply.mods).toEqual([{ id: 'frost', stacks: 1 }])
  })

  it('the mutation is inspectable via get (mods ride in the entity JSON)', () => {
    const id = armedPlayer(w)
    runVerb(w, `addMod ${id} bounce 2`)
    const e = JSON.parse(runVerb(w, `get ${id}`))
    expect(e.loadout!.inventory[0].mods).toEqual([{ id: 'bounce', stacks: 2 }])
  })

  it('rejects an unknown mod id', () => {
    const id = armedPlayer(w)
    expect(() => runVerb(w, `addMod ${id} nope`)).toThrow(/unknown mod/)
  })

  it('rejects a non-positive / non-integer stack count', () => {
    const id = armedPlayer(w)
    expect(() => runVerb(w, `addMod ${id} frost 0`)).toThrow(/positive integer/)
    expect(() => runVerb(w, `addMod ${id} frost -3`)).toThrow(/positive integer/)
    expect(() => runVerb(w, `addMod ${id} frost 1.5`)).toThrow(/positive integer/)
  })

  it('errors clearly when the entity has no slotted weapon', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    // Strip the starter loadout: bare hands, nothing slotted.
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    p.combat!.weapon = 'fists'
    expect(() => runVerb(w, `addMod ${p.id} frost`)).toThrow(/no slotted weapon/)
  })

  it('errors on a missing entity', () => {
    expect(() => runVerb(w, `addMod 9999 frost`)).toThrow(/no entity/)
  })
})
