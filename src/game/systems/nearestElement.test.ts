// A mod that makes its own hit (split shards, splinter shrapnel, an explosive or
// detonator blast) carries the element closest to it on the weapon's mod list
// (#119). The round itself keeps #106's rule: the newest element lands.
//
// Every fire-path case sets exact world state and runs the real systems.

import { describe, expect, it } from 'vitest'
import { MODS } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm, expectWorldEqual } from '../testkit'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { combatSystem } from './combat'
import { weaponStack } from './inventory'
import { projectileSystem } from './projectiles'
import { elementFor } from './resolveWeapon'
import { hasStatus, isPanicking } from './statusFx'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })
const STATUS_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const STATUSES = Object.values(STATUS_OF)
const isElement = (id: string): boolean => MODS[id]?.onHit !== undefined

const rig = (mods: (string | WeaponMod)[], weapon = 'pistol'): { w: World; p: Entity } => {
  // Seed 1 floor 1 has an open corridor over y 18..22, x 14..36: every stage
  // below stays inside it, so no wall stops a round, shard or blast.
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  arm(p, weapon).mods = mods.map((x) => (typeof x === 'string' ? m(x) : { ...x }))
  p.facing = 0
  return { w, p }
}

const body = (w: World, x: number, y: number, hp = 400): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

/** A 1-hp body the round kills on contact, plus a pack around it inside both
 * the explosive (1.6) and detonator (2.0) blast radii, plus one body well out. */
const stage = (w: World): { first: Entity; pack: Entity[]; far: Entity } => ({
  first: body(w, 24, 20, 1),
  pack: [body(w, 24.8, 20.9), body(w, 24.8, 19.1), body(w, 23.4, 21.1)],
  far: body(w, 30, 21.5),
})

const statuses = (e: Entity): string[] => STATUSES.filter((s) => hasStatus(e, s))

/** One trigger pull through the real systems; returns every event it caused. */
const fire = (w: World, ticks = 20): SimEvent[] => {
  const events: SimEvent[] = []
  tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]]))
  events.push(...w.events)
  for (let i = 0; i < ticks; i++) {
    tickWorld(w, new Map([[0, emptyInput()]]))
    events.push(...w.events)
  }
  return events
}

/** Pull once and stop the moment the round spawns its children. */
const children = (mods: (string | WeaponMod)[], weapon = 'pistol'): { shards: Entity[]; frags: Entity[]; round: Entity } => {
  const { w, p } = rig(mods, weapon)
  body(w, 24, 20, 1)
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  const round = w.entities.find((e) => e.kind === 'projectile')!
  for (let i = 0; i < 40 && !round.dead; i++) {
    projectileSystem(w)
    w.tick++
  }
  const kids = w.entities.filter((e) => e.kind === 'projectile' && e !== round)
  return { round, shards: kids.filter((e) => e.radius === 0.12), frags: kids.filter((e) => e.radius === 0.1) }
}

const carried = (e: Entity): string[] => {
  const status = e.projectile!.onHit?.status
  return status ? Object.keys(STATUS_OF).filter((id) => STATUS_OF[id] === status) : []
}
const shownElements = (e: Entity): string[] => (e.projectile!.mods ?? []).map((x) => x.id).filter(isElement)

const blasts = (events: SimEvent[]): Extract<SimEvent, { type: 'explosion' }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: 'explosion' }> => e.type === 'explosion')

describe('elementFor: the element closest to a mod in the list', () => {
  const at = (list: string[], id: string): string | undefined =>
    elementFor(list.indexOf(id), list.map((x) => m(x)))?.id

  it('a tie goes to the later element', () => {
    expect(at(['frost', 'split', 'shock'], 'split')).toBe('shock')
    expect(at(['shock', 'explosive', 'frost'], 'explosive')).toBe('frost')
  })

  it('a nearer element beats a newer one', () => {
    expect(at(['frost', 'split', 'rapid', 'shock'], 'split')).toBe('frost')
    expect(at(['shock', 'rapid', 'split', 'frost'], 'split')).toBe('frost')
  })

  it('an element at either end of the list reaches a mod at the other end', () => {
    expect(at(['shock', 'rapid', 'heavy', 'split'], 'split')).toBe('shock')
    expect(at(['split', 'rapid', 'heavy', 'frost'], 'split')).toBe('frost')
  })

  it('a list with no element gives none', () => {
    expect(at(['split', 'rapid', 'explosive'], 'split')).toBeUndefined()
    expect(at(['split'], 'split')).toBeUndefined()
    expect(elementFor(0, [])).toBeUndefined()
  })
})

describe('fold mode: shards carry the element closest to their mod', () => {
  it('Cryo then Splinter: the shards freeze (#119: they used to look icy and apply nothing)', () => {
    const { shards } = children(['frost', 'split'])
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(s.projectile!.onHit).toEqual({ status: 'frozen', ticks: 120 })
      expect(shownElements(s)).toEqual(['frost'])
    }
  })

  it('[frost, split, shock]: a shock round whose shards carry shock (a tie, the later wins)', () => {
    const { round, shards } = children(['frost', 'split', 'shock'])
    expect(round.projectile!.onHit?.status).toBe('electrified')
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(carried(s)).toEqual(['shock'])
      expect(shownElements(s)).toEqual(['shock'])
    }
  })

  it('[frost, split, rapid, shock]: a shock round whose shards carry frost (distance 1 against 2)', () => {
    const { round, shards } = children(['frost', 'split', 'rapid', 'shock'])
    expect(round.projectile!.onHit?.status).toBe('electrified')
    expect(round.projectile!.mods).toEqual([m('rapid'), m('shock'), m('split')])
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(carried(s)).toEqual(['frost'])
      expect(s.projectile!.mods).toEqual([m('frost'), m('rapid'), m('split')])
    }
  })

  it('a shard that reaches a body freezes it, and the round that split does not', () => {
    const { w } = rig(['frost', 'split', 'rapid', 'shock'])
    const first = body(w, 24, 20, 1)
    // The upper shard leaves ~(23.5, 20) at +0.45 rad.
    const reached = body(w, 23.5 + 2.5 * Math.cos(0.45), 20 + 2.5 * Math.sin(0.45))
    fire(w, 15)
    expect(first.dead).toBe(true)
    expect(reached.health!.hp).toBe(400 - 7)
    expect(statuses(reached)).toEqual(['frozen'])
  })

  it('[frost, splinterShot, rapid, shock]: shrapnel carries frost, not the round element it used to copy', () => {
    const { round, frags } = children(['frost', 'splinterShot', 'rapid', 'shock'])
    expect(round.projectile!.onHit?.status).toBe('electrified')
    expect(frags).toHaveLength(4)
    for (const f of frags) {
      expect(carried(f)).toEqual(['frost'])
      expect(shownElements(f)).toEqual(['frost'])
    }
  })

  it('a stacked split still carries its nearest element', () => {
    const { shards } = children([m('shock'), m('split', 3), m('rapid'), m('frost')])
    expect(shards).toHaveLength(6)
    for (const s of shards) expect(carried(s)).toEqual(['shock'])
  })

  it('no element on the list: shards and shrapnel stay element-free and look it', () => {
    const { shards, frags } = children(['rapid', 'split', 'splinterShot'])
    expect(shards).toHaveLength(2)
    expect(frags).toHaveLength(4)
    for (const k of [...shards, ...frags]) {
      expect(k.projectile!.onHit).toBeUndefined()
      expect(shownElements(k)).toEqual([])
    }
  })

  it("a base weapon's innate element is not a list entry: freeze-ray shards stay element-free", () => {
    const { round, shards } = children(['split'], 'freezeRay')
    expect(round.projectile!.onHit?.status).toBe('frozen')
    expect(shards).toHaveLength(2)
    for (const s of shards) expect(s.projectile!.onHit).toBeUndefined()
  })

  it.each([
    ['an unknown id', [m('frost'), m('split'), m('no-such-mod'), m('shock')]],
    ['a zero-stack entry', [m('frost'), m('split'), m('heavy', 0), m('shock')]],
  ])('%s takes no place in the list: the tie still goes to shock', (_label, mods) => {
    const { shards } = children(mods)
    for (const s of shards) expect(carried(s)).toEqual(['shock'])
  })

  it('a zero-stack element is not an element', () => {
    const { shards } = children([m('frost'), m('split'), m('shock', 0)])
    for (const s of shards) expect(carried(s)).toEqual(['frost'])
  })
})

describe('fold mode: blasts carry the element closest to their mod', () => {
  it('[frost, explosive, shock]: the blast electrifies every body it damages (a tie, the later wins)', () => {
    const { w } = rig(['frost', 'explosive', 'shock'])
    const { pack, far } = stage(w)
    const events = fire(w)
    const [blast] = blasts(events)
    expect(blast.element).toBe('shock')
    for (const b of pack) {
      expect(b.health!.hp).toBeLessThan(400)
      expect(statuses(b)).toEqual(['electrified'])
    }
    expect(far.health!.hp).toBe(400)
    expect(statuses(far)).toEqual([])
  })

  it('[frost, explosive, rapid, shock]: the blast freezes (distance 1 against 2)', () => {
    const { w } = rig(['frost', 'explosive', 'rapid', 'shock'])
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast.element).toBe('frost')
    for (const b of pack) expect(statuses(b)).toEqual(['frozen'])
  })

  it('[frost, detonator, rapid, shock]: the kill blast freezes the pack while the round zapped its victim', () => {
    const { w } = rig(['frost', 'detonator', 'rapid', 'shock'])
    const { first, pack } = stage(w)
    const events = fire(w)
    expect(first.dead).toBe(true)
    const [blast] = blasts(events)
    expect(blast.element).toBe('frost')
    for (const b of pack) {
      expect(b.health!.hp).toBe(400 - 24)
      expect(statuses(b)).toEqual(['frozen'])
    }
  })

  it('no element on the list: the blast damages and applies nothing, and its event names none', () => {
    const { w } = rig(['rapid', 'explosive'])
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast).toEqual({ type: 'explosion', x: blast.x, y: blast.y, radius: blast.radius })
    for (const b of pack) {
      expect(b.health!.hp).toBeLessThan(400)
      expect(statuses(b)).toEqual([])
    }
  })

  it("an innate element does not ride the blast: a freeze-ray explosive round's blast only damages", () => {
    const { w } = rig(['explosive'], 'freezeRay')
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast.element).toBeUndefined()
    for (const b of pack) expect(statuses(b)).toEqual([])
  })

  it('a body the blast does not damage (i-frames) gains no element either', () => {
    const { w } = rig(['frost', 'explosive'])
    const { pack } = stage(w)
    const [guarded, ...rest] = pack
    guarded.health!.iframes = 30
    fire(w, 12)
    expect(guarded.health!.hp).toBe(400)
    expect(statuses(guarded)).toEqual([])
    for (const b of rest) expect(statuses(b)).toEqual(['frozen'])
  })

  it('the shooter caught in its own blast takes the element with the damage', () => {
    const { w, p } = rig(['incendiary', 'explosive'])
    body(w, 21.2, 20)
    p.health!.iframes = 0
    const hp = p.health!.hp
    fire(w, 1)
    expect(p.health!.hp).toBeLessThan(hp)
    expect(statuses(p)).toEqual(['burning'])
  })
})

describe('a carried element does what that element does (#92 verbs)', () => {
  /** Tick until the round's first blast; returns the events of that tick. */
  const untilBlast = (w: World): SimEvent[] => {
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]]))
    for (let i = 0; i < 20 && !blasts(w.events).length; i++) tickWorld(w, new Map([[0, emptyInput()]]))
    return [...w.events]
  }

  it('[incendiary, explosive, rapid, frost]: the blast sets the pack burning and panicking, while the round freezes', () => {
    const { w, p } = rig(['incendiary', 'explosive', 'rapid', 'frost'])
    expect(weaponStack(p)).toBeDefined()
    body(w, 24, 20, 1)
    const pack = [spawnNpc(w, 'thug', 24.8, 20.9), spawnNpc(w, 'thug', 24.8, 19.1), spawnNpc(w, 'thug', 23.4, 21.1)]
    const [blast] = blasts(untilBlast(w))
    expect(blast.element).toBe('incendiary')
    for (const t of pack) {
      expect(t.health!.hp).toBeLessThan(t.health!.max)
      expect(statuses(t)).toEqual(['burning'])
      expect(isPanicking(w, t)).toBe(true)
      expect(t.fx!.burning.source).toBe(p.id)
    }
  })

  it('[shock, split, rapid, frost]: a shard carrying shock stuns what it reaches and leaps to the next NPC', () => {
    const { w, p } = rig(['shock', 'split', 'rapid', 'frost'])
    const first = body(w, 24, 20, 1)
    const reached = spawnNpc(w, 'thug', 23.5 + 2.5 * Math.cos(0.45), 20 + 2.5 * Math.sin(0.45))
    reached.health!.hp = reached.health!.max = 400
    const beside = spawnNpc(w, 'thug', reached.pos.x + 0.6, reached.pos.y + 1.4)
    const events = fire(w, 12)
    expect(first.dead).toBe(true)
    expect(statuses(first)).toEqual([])
    expect(reached.health!.hp).toBeLessThan(400)
    expect(statuses(reached)).toEqual(['electrified'])
    expect(statuses(beside)).toEqual(['electrified'])
    expect(beside.health!.hp).toBe(beside.health!.max)
    expect(events).toContainEqual(expect.objectContaining({ type: 'shock', targetId: beside.id }))
    expect(p.fx?.electrified).toBeUndefined()
  })
})

describe('sequenced mode: a cast carries its own payload', () => {
  const sequenced = (mods: string[]): { w: World; p: Entity } => {
    const r = rig(mods)
    r.w.modCasting = 'sequence'
    return r
  }

  /** Pull the trigger `n` times against fresh 1-hp bodies; returns each pull's shards. */
  const pulls = (w: World, p: Entity, n: number): Entity[][] => {
    const out: Entity[][] = []
    for (let k = 0; k < n; k++) {
      const stack = weaponStack(p)!
      stack.rechargeUntil = undefined
      for (const e of w.entities) if (e.kind !== 'player') e.dead = true
      w.entities = w.entities.filter((e) => !e.dead)
      w.byId = new Map(w.entities.map((e) => [e.id, e]))
      body(w, 24, 20, 1)
      p.combat!.cooldown = 0
      combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
      const round = w.entities.find((e) => e.kind === 'projectile')!
      for (let i = 0; i < 40 && !round.dead; i++) {
        projectileSystem(w)
        w.tick++
      }
      out.push(w.entities.filter((e) => e.kind === 'projectile' && e !== round && e.radius === 0.12))
    }
    return out
  }

  it('[frost, split, rapid, shock]: split rides the shock that ends its cast, where fold mode picks frost', () => {
    const { w, p } = sequenced(['frost', 'split', 'rapid', 'shock'])
    const [first, second] = pulls(w, p, 2)
    expect(first).toEqual([])
    expect(second).toHaveLength(2)
    for (const s of second) expect(carried(s)).toEqual(['shock'])
    for (const s of children(['frost', 'split', 'rapid', 'shock']).shards) expect(carried(s)).toEqual(['frost'])
  })

  it('[frost, split]: a trailing split has no payload in its cast, so its shards stay element-free', () => {
    const { w, p } = sequenced(['frost', 'split'])
    const [, second] = pulls(w, p, 2)
    expect(second).toHaveLength(2)
    for (const s of second) {
      expect(s.projectile!.onHit).toBeUndefined()
      expect(shownElements(s)).toEqual([])
    }
  })

  it('every ordering: shards carry the first element at or after split, none when the cast wraps', () => {
    const pool = ['frost', 'shock', 'split', 'rapid']
    const orderings = (xs: string[]): string[][] =>
      xs.length === 0 ? [[]] : xs.flatMap((x, i) => orderings([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]))
    let agree = 0
    let differ = 0
    for (const list of orderings(pool)) {
      const { w, p } = sequenced(list)
      const castsToSplit = list.slice(0, list.indexOf('split')).filter(isElement).length + 1
      const shards = pulls(w, p, castsToSplit).at(-1)!
      const after = list.slice(list.indexOf('split')).find(isElement)
      const label = list.join(' > ')
      expect(shards, label).toHaveLength(2)
      for (const s of shards) {
        expect(carried(s), label).toEqual(after ? [after] : [])
        expect(shownElements(s), label).toEqual(after ? [after] : [])
      }
      const folded = elementFor(list.indexOf('split'), list.map((x) => m(x)))?.id
      if (folded === after) agree++
      else differ++
    }
    expect(agree + differ).toBe(24)
    expect(differ).toBeGreaterThan(0)
  })
})

describe('determinism', () => {
  const FIGHT = ['frost', 'split', 'incendiary', 'splinterShot', 'rapid', 'detonator', 'shock']
  const burst = (t: number): Map<number, InputCmd> =>
    new Map([[0, { ...emptyInput(), seq: t, attack: t % 3 !== 0, aimX: 1, aimY: Math.sin(t * 0.3) * 0.4 }]])

  const fight = (): World => {
    const { w } = rig(FIGHT, 'shotgun')
    stage(w)
    for (let i = 0; i < 6; i++) body(w, 22 + i * 0.9, 18 + (i % 3) * 2, 60)
    return w
  }

  it('a fight serialized mid-flight replays byte for byte, carried elements included', () => {
    const live = fight()
    const carrying = (): Entity[] => live.entities.filter((e) => e.projectile?.split?.element || e.projectile?.splinter?.element)
    let t = 1
    for (; t <= 60 && (t < 30 || carrying().length === 0); t++) tickWorld(live, burst(t))
    expect(carrying().length).toBeGreaterThan(0)
    const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(live))))
    for (; t <= 120; t++) {
      tickWorld(live, burst(t))
      tickWorld(copy, burst(t))
    }
    expectWorldEqual(live, copy)
    // Only the carried element burns here: the round itself lands shock.
    expect(live.entities.some((e) => e.kind === 'npc' && hasStatus(e, 'burning'))).toBe(true)
  })

  it('two runs from the same seed and inputs agree', () => {
    const a = fight()
    const b = fight()
    for (let t = 1; t <= 90; t++) {
      tickWorld(a, burst(t))
      tickWorld(b, burst(t))
    }
    expectWorldEqual(a, b)
  })
})
