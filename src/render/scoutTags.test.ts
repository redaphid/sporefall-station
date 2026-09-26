import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { applyTraitPick } from '../game/systems/traits'
import { createWorld } from '../game/world'
import { SCOUT_RANGE, scoutTags } from './scoutTags'

const scene = (traits: string[]) => {
  const w = createWorld(1, 1, 'normal', false)
  const self = spawnPlayer(w, 0, 10, 10)
  for (const t of traits) applyTraitPick(self, t)
  const brute = spawnNpc(w, 'brute', 13, 10)
  const robot = spawnNpc(w, 'robot', 10, 13)
  const thug = spawnNpc(w, 'thug', 7, 10)
  return { w, self, brute, robot, thug }
}

describe('Scout Eye tags', () => {
  it('without Scout Eye nothing is tagged', () => {
    const { w, self } = scene([])
    expect(scoutTags(w.entities, self)).toEqual([])
    expect(scoutTags(w.entities, undefined)).toEqual([])
  })

  it('a scout reads each nearby enemy: what to use on it and what not to bother with', () => {
    const { w, self, brute, robot } = scene(['scoutEye'])
    expect(scoutTags(w.entities, self)).toEqual([
      {
        id: brute.id,
        lines: [
          { tone: 'weak', text: 'weak: fire' },
          { tone: 'tough', text: 'tough: bullets' },
        ],
      },
      {
        id: robot.id,
        lines: [
          { tone: 'weak', text: 'weak: fire' },
          { tone: 'tough', text: 'tough: bullets' },
          { tone: 'immune', text: 'immune: spores' },
        ],
      },
    ])
  })

  it('a plain enemy, a dead one, and one out of range get no tag', () => {
    const { w, self, brute, robot } = scene(['scoutEye'])
    brute.dead = true
    robot.pos = { x: 10, y: 10 + SCOUT_RANGE + 0.5 }
    expect(scoutTags(w.entities, self)).toEqual([])
  })

  it('a net client, whose entities carry no resist table, reads the same tags from the archetype', () => {
    const { w, self } = scene(['scoutEye'])
    const host = scoutTags(w.entities, self)
    for (const e of w.entities) delete e.resist
    expect(scoutTags(w.entities, self)).toEqual(host)
  })

  it('only names damage a player can deal: a poison resist alone tags nothing', () => {
    const { w, self, brute } = scene(['scoutEye'])
    brute.resist = { poisoned: 0 }
    expect(scoutTags(w.entities, self).find((t) => t.id === brute.id)).toBeUndefined()
  })
})
