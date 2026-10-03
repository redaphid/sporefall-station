import { describe, expect, it } from 'vitest'
import { generateLevel } from './levelgen/generate'
import { isSolidTile, levelChecksum } from './levelgen/level'
import { serializeWorld } from './serialize'
import { expectWorldEqual, loadFixture, loadFixtureJson, runTicks } from './testkit'
import type { InputCmd } from './types'

// The crafted `castle-siege` save (scripts/saves/castle-siege.mts): a drawn
// castle, a player at the drawbridge with a four-mod pistol, a garrison inside.

const STORM = new Map<number, Partial<InputCmd>>([[0, { moveY: -1, aimX: 0, aimY: -1, attack: true }]])

describe('castle-siege save', () => {
  it('is an authored world: its level is the drawn castle, not seed+floor', () => {
    const j = loadFixtureJson('castle-siege')
    expect(j.levelChecksum).toBeUndefined()
    expect(j.level?.rows).toHaveLength(32)
    expect(j.level?.rows[7]).toBe(',,~~#.........#++++++E+++++++#.........#~~,,')
    const w = loadFixture('castle-siege')
    expect(levelChecksum(w.level)).not.toBe(levelChecksum(generateLevel(j.seed, j.floor)))
    expect(w.level.exit).toEqual({ x: 21, y: 7 })
  })

  it('starts the player at the drawbridge carrying split + frost + pierce x2 + homing', () => {
    const w = loadFixture('castle-siege')
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players).toHaveLength(1)
    const [p] = players
    expect(p.pos).toEqual({ x: 21.5, y: 30.5 })
    expect(p.combat?.weapon).toBe('pistol')
    expect(p.loadout?.inventory[0]).toMatchObject({
      itemId: 'pistol',
      mods: [
        { id: 'split', stacks: 1 },
        { id: 'frost', stacks: 1 },
        { id: 'pierce', stacks: 2 },
        { id: 'homing', stacks: 1 },
      ],
    })
  })

  it('garrisons every NPC on open ground inside the curtain wall', () => {
    const w = loadFixture('castle-siege')
    const npcs = w.entities.filter((e) => !e.playerCtl)
    expect(npcs.map((e) => e.archetype).sort()).toEqual(
      ['boss', 'brute', 'gangster', 'gangster', 'lobber', 'lobber', 'thug', 'thug', 'thug', 'thug'].sort(),
    )
    for (const e of npcs) {
      const tx = Math.floor(e.pos.x)
      const ty = Math.floor(e.pos.y)
      expect(isSolidTile(w.level, tx, ty), `${e.archetype}#${e.id} at ${tx},${ty}`).toBe(false)
      expect(tx > 4 && tx < 39 && ty > 3 && ty < 25, `${e.archetype}#${e.id} at ${tx},${ty}`).toBe(true)
    }
  })

  it('plays: storming the gate draws the garrison into a fight, the same way every load', () => {
    const a = runTicks(loadFixture('castle-siege'), STORM, 300)
    const b = runTicks(loadFixture('castle-siege'), STORM, 300)
    expectWorldEqual(a, b)
    const start = loadFixture('castle-siege')
    const hpAtStart = new Map(start.entities.filter((e) => !e.playerCtl).map((e) => [e.id, e.health!.hp]))
    const hurt = [...hpAtStart].filter(([id, hp]) => {
      const now = a.byId.get(id)
      return !now || now.health!.hp < hp
    })
    expect(hurt.length).toBeGreaterThan(0)
    const p = a.entities.find((e) => e.playerCtl)!
    expect(p.pos.y, 'the player made it through the gate').toBeLessThan(25)
  })

  it('keeps the keep exit locked while the castle lord lives', () => {
    const w = loadFixture('castle-siege')
    expect(w.mission).toMatchObject({ template: 'assassinate', complete: false, exitUnlocked: false })
    expect(w.byId.get(w.mission.targetEntityId!)?.archetype).toBe('boss')
    const p = w.entities.find((e) => e.playerCtl)!
    p.pos = { x: 21.5, y: 7.5 }
    p.prevPos = { ...p.pos }
    runTicks(w, new Map(), 5)
    expect(w.floor).toBe(1)
    w.byId.get(w.mission.targetEntityId!)!.dead = true
    runTicks(w, new Map(), 5)
    expect(w.floor).toBe(2)
  })

  it('re-saves to itself exactly', () => {
    expect(serializeWorld(loadFixture('castle-siege'))).toEqual(loadFixtureJson('castle-siege'))
  })
})
