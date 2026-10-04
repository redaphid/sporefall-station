import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type Faction } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { aiSystem } from './ai'
import {
  addHate,
  commitMisdeed,
  MISDEED_HATE,
  determineRel,
  dispositionToward,
  initialFactionHate,
  initialPlayerHate,
} from './relationships'

const ARCH: Record<Faction, string> = { warden: 'warden', feral: 'acolyte', neutral: 'lockkeeper', civ: 'civilian' }

const npc = (w: World, faction: Faction, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('npc', ARCH[faction], x, y))
  e.health = { hp: 60, max: 60, iframes: 0 }
  e.combat = { weapon: 'wrench', cooldown: 0 }
  e.ai = { mode: 'idle', faction, home: { x, y }, thinkAt: 0, sightRange: 8 }
  return e
}

const player = (w: World, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, misdeedUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

describe('relationships', () => {
  it('determineRel maps hate to the threshold ladder', () => {
    expect(determineRel(-1)).toBe('Friendly')
    expect(determineRel(0)).toBe('Neutral')
    expect(determineRel(3)).toBe('Annoyed')
    expect(determineRel(5)).toBe('Hostile')
    expect(determineRel(50)).toBe('Hostile')
  })

  it('faction matrix: same friendly, warden vs feral hostile, unrelated neutral', () => {
    expect(initialFactionHate('warden', 'warden')).toBeLessThan(0)
    expect(determineRel(initialFactionHate('warden', 'feral'))).toBe('Hostile')
    expect(initialFactionHate('civ', 'warden')).toBe(0)
  })

  it('initial player disposition: feral hostile, warden and civ neutral', () => {
    expect(determineRel(initialPlayerHate('feral'))).toBe('Hostile')
    expect(determineRel(initialPlayerHate('warden'))).toBe('Neutral')
    expect(determineRel(initialPlayerHate('civ'))).toBe('Neutral')
  })

  it('addHate accumulates and re-derives the band', () => {
    const w = createWorld(1, 1)
    const warden = npc(w, 'warden', 20, 20)
    addHate(warden, 99, 3)
    expect(dispositionToward(warden, 99)).toBe('Annoyed')
    addHate(warden, 99, 3)
    expect(dispositionToward(warden, 99)).toBe('Hostile')
  })

  it('a dead agent accrues no hate', () => {
    const w = createWorld(1, 1)
    const warden = npc(w, 'warden', 20, 20)
    warden.dead = true
    addHate(warden, 99, MISDEED_HATE)
    expect(dispositionToward(warden, 99)).toBe('Neutral')
  })

  describe('witnessed misdeed', () => {
    let w: World
    let p: Entity
    let victim: Entity
    beforeEach(() => {
      w = createWorld(1, 1)
      p = player(w, 20, 20)
      victim = npc(w, 'civ', 21, 20)
    })

    it('a nearby warden turns hostile and aggroes the attacker', () => {
      const warden = npc(w, 'warden', 23, 20)
      commitMisdeed(w, victim, p)
      expect(dispositionToward(warden, p.id)).toBe('Hostile')
      expect(warden.ai!.mode).toBe('aggro')
      expect(warden.ai!.targetId).toBe(p.id)
    })

    it('an unrelated neutral faction stays neutral and calm', () => {
      const lockkeeper = npc(w, 'neutral', 23, 20)
      commitMisdeed(w, victim, p)
      expect(dispositionToward(lockkeeper, p.id)).toBe('Neutral')
      expect(lockkeeper.ai!.mode).not.toBe('aggro')
    })

    it('a warden out of sight stays neutral', () => {
      const far = npc(w, 'warden', 45, 45)
      commitMisdeed(w, victim, p)
      expect(dispositionToward(far, p.id)).toBe('Neutral')
    })

    it('a witnessing civilian flees the attacker rather than fighting', () => {
      const bystander = npc(w, 'civ', 22, 20)
      commitMisdeed(w, victim, p)
      expect(bystander.ai!.mode).toBe('flee')
      expect(bystander.ai!.targetId).toBe(p.id)
    })
  })

  it('a feral NPC (hostile disposition) aggroes a visible player unprovoked', () => {
    const w = createWorld(1, 1)
    const p = player(w, 20, 20)
    const mutant = npc(w, 'feral', 22, 20)
    mutant.ai!.thinkAt = 0
    aiSystem(w)
    expect(mutant.ai!.mode).toBe('aggro')
    expect(mutant.ai!.targetId).toBe(p.id)
  })
})
