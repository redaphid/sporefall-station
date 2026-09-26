// The addTrait debug verb: the draft YOU card's pick, reachable by an agent.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { createWorld } from '../game/world'
import { runVerb, WRITE_VERBS } from './verbs'

describe('addTrait verb', () => {
  it('is a WRITE verb and gives a player a trait, capped like a draft pick', () => {
    expect(WRITE_VERBS.has('addTrait')).toBe(true)
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    expect(JSON.parse(runVerb(w, `addTrait ${p.id} softSteps`))).toEqual({
      id: p.id,
      stacks: 1,
      maxed: false,
      traits: [{ id: 'softSteps', stacks: 1 }],
    })
    runVerb(w, `addTrait ${p.id} softSteps`)
    expect(JSON.parse(runVerb(w, `addTrait ${p.id} softSteps`))).toMatchObject({ stacks: 2, maxed: true })
    expect(p.playerCtl!.traits).toEqual([{ id: 'softSteps', stacks: 2 }])
  })

  it('refuses an unknown trait, a missing entity, and a body that is not a player', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    const npc = spawnNpc(w, 'thug', 22, 20)
    expect(() => runVerb(w, `addTrait ${p.id} wings`)).toThrow(/unknown trait/)
    expect(() => runVerb(w, `addTrait ${p.id}`)).toThrow(/unknown trait/)
    expect(() => runVerb(w, `addTrait 9999 anchor`)).toThrow(/no entity/)
    expect(() => runVerb(w, `addTrait ${npc.id} anchor`)).toThrow(/not a player/)
    expect(npc.playerCtl).toBeUndefined()
  })
})
