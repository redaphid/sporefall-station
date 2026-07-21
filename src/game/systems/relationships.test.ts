import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type Faction } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { aiSystem } from './ai'
import {
  addHate,
  commitCrime,
  CRIME_HATE,
  determineRel,
  dispositionToward,
  initialFactionHate,
  initialPlayerHate,
} from './relationships'

const ARCH: Record<Faction, string> = { cop: 'cop', gang: 'gangster', neutral: 'bouncer', civ: 'civilian' }

const npc = (w: World, faction: Faction, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('npc', ARCH[faction], x, y))
  e.health = { hp: 60, max: 60, iframes: 0 }
  e.combat = { weapon: 'bat', cooldown: 0 }
  e.ai = { mode: 'idle', faction, home: { x, y }, thinkAt: 0, sightRange: 8 }
  return e
}

const player = (w: World, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
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

  it('faction matrix: same friendly, cop vs gang hostile, unrelated neutral', () => {
    expect(initialFactionHate('cop', 'cop')).toBeLessThan(0)
    expect(determineRel(initialFactionHate('cop', 'gang'))).toBe('Hostile')
    expect(initialFactionHate('civ', 'cop')).toBe(0)
  })

  it('initial player disposition: gang hostile, cop and civ neutral', () => {
    expect(determineRel(initialPlayerHate('gang'))).toBe('Hostile')
    expect(determineRel(initialPlayerHate('cop'))).toBe('Neutral')
    expect(determineRel(initialPlayerHate('civ'))).toBe('Neutral')
  })

  it('addHate accumulates and re-derives the band', () => {
    const w = createWorld(1, 1)
    const cop = npc(w, 'cop', 20, 20)
    addHate(cop, 99, 3)
    expect(dispositionToward(cop, 99)).toBe('Annoyed')
    addHate(cop, 99, 3)
    expect(dispositionToward(cop, 99)).toBe('Hostile')
  })

  it('a dead agent accrues no hate', () => {
    const w = createWorld(1, 1)
    const cop = npc(w, 'cop', 20, 20)
    cop.dead = true
    addHate(cop, 99, CRIME_HATE)
    expect(dispositionToward(cop, 99)).toBe('Neutral')
  })

  describe('witnessed crime', () => {
    let w: World
    let p: Entity
    let victim: Entity
    beforeEach(() => {
      w = createWorld(1, 1)
      p = player(w, 20, 20)
      victim = npc(w, 'civ', 21, 20)
    })

    it('a nearby cop turns hostile and aggroes the attacker', () => {
      const cop = npc(w, 'cop', 23, 20)
      commitCrime(w, victim, p)
      expect(dispositionToward(cop, p.id)).toBe('Hostile')
      expect(cop.ai!.mode).toBe('aggro')
      expect(cop.ai!.targetId).toBe(p.id)
    })

    it('an unrelated neutral faction stays neutral and calm', () => {
      const bouncer = npc(w, 'neutral', 23, 20)
      commitCrime(w, victim, p)
      expect(dispositionToward(bouncer, p.id)).toBe('Neutral')
      expect(bouncer.ai!.mode).not.toBe('aggro')
    })

    it('a cop out of sight stays neutral', () => {
      const far = npc(w, 'cop', 45, 45)
      commitCrime(w, victim, p)
      expect(dispositionToward(far, p.id)).toBe('Neutral')
    })

    it('a witnessing civilian flees the attacker rather than fighting', () => {
      const bystander = npc(w, 'civ', 22, 20)
      commitCrime(w, victim, p)
      expect(bystander.ai!.mode).toBe('flee')
      expect(bystander.ai!.targetId).toBe(p.id)
    })
  })

  it('a gang NPC (hostile disposition) aggroes a visible player unprovoked', () => {
    const w = createWorld(1, 1)
    const p = player(w, 20, 20)
    const thug = npc(w, 'gang', 22, 20)
    thug.ai!.thinkAt = 0
    aiSystem(w)
    expect(thug.ai!.mode).toBe('aggro')
    expect(thug.ai!.targetId).toBe(p.id)
  })
})
