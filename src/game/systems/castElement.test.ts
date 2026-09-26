// A round's split shards, splinter shrapnel, explosive blast and detonator blast
// carry the element that ends the round's cast (#119): a modifier rides the next
// element after it in list order, and trailing modifiers form a bare cast that
// carries none. Sequenced casting is being made the only firing mode, so every
// case here forces `modCasting = 'sequence'`.
//
// Every case sets exact world state and runs the real systems.

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
import { hasStatus, isPanicking } from './statusFx'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })
const STATUS_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const STATUSES = Object.values(STATUS_OF)
const isElement = (id: string): boolean => MODS[id]?.onHit !== undefined

/** A sequenced gun facing east, its next cast starting at window position `at`.
 * Seed 1 floor 1 has an open corridor over y 18..22, x 14..36: every stage
 * below stays inside it, so no wall stops a round, shard or blast. */
const rig = (mods: string[], at = 0, weapon = 'pistol'): { w: World; p: Entity } => {
  const w = createWorld(1, 1)
  w.modCasting = 'sequence'
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  const stack = arm(p, weapon)
  stack.mods = mods.map((id) => m(id))
  stack.castIndex = at
  p.facing = 0
  return { w, p }
}

const body = (w: World, x: number, y: number, hp = 400): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

/** A 1-hp body the round kills on contact, and a pack around it inside both
 * the explosive (1.6) and detonator (2.0) blast radii. */
const stage = (w: World): { first: Entity; pack: Entity[]; far: Entity } => ({
  first: body(w, 24, 20, 1),
  pack: [body(w, 24.8, 20.9), body(w, 24.8, 19.1), body(w, 23.4, 21.1)],
  far: body(w, 30, 21.5),
})

const statuses = (e: Entity): string[] => STATUSES.filter((s) => hasStatus(e, s))

/** One trigger pull through tickWorld; returns every event it caused. */
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

/** Pull once and stop the moment the round dies, so its children are fresh. */
const children = (mods: string[], at = 0, weapon = 'pistol'): { round: Entity; shards: Entity[]; frags: Entity[] } => {
  const { w } = rig(mods, at, weapon)
  body(w, 24, 20, 1)
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  const round = w.entities.find((e) => e.kind === 'projectile')!
  expect(round, `${mods} @${at}: a round`).toBeDefined()
  for (let i = 0; i < 40 && !round.dead; i++) {
    projectileSystem(w)
    w.tick++
  }
  const kids = w.entities.filter((e) => e.kind === 'projectile' && e !== round)
  return { round, shards: kids.filter((e) => e.radius === 0.12), frags: kids.filter((e) => e.radius === 0.1) }
}

const applies = (e: Entity): string[] => {
  const status = e.projectile!.onHit?.status
  return status ? Object.keys(STATUS_OF).filter((id) => STATUS_OF[id] === status) : []
}
const shows = (e: Entity): string[] => (e.projectile!.mods ?? []).map((x) => x.id).filter(isElement)

const blasts = (events: SimEvent[]): Extract<SimEvent, { type: 'explosion' }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: 'explosion' }> => e.type === 'explosion')

describe("shards and shrapnel carry the element that ends their round's cast", () => {
  it('the owner\'s example: bouncy, bouncy, fire, splinter, ice shoots "bouncy bouncy fire", then "splinter ice"', () => {
    const list = ['bounce', 'bounce', 'incendiary', 'splinterShot', 'frost']
    const first = children(list, 0, 'machinegun')
    expect(first.round.projectile!.onHit?.status).toBe('burning')
    expect(first.round.projectile!.mods).toEqual([m('bounce', 2), m('incendiary')])
    expect(first.frags).toEqual([])
    const second = children(list, 3, 'machinegun')
    expect(second.round.projectile!.onHit?.status).toBe('frozen')
    expect(second.frags).toHaveLength(4)
    for (const f of second.frags) {
      expect(applies(f)).toEqual(['frost'])
      expect(f.projectile!.mods).toEqual([m('frost'), m('splinterShot')])
    }
  })

  it('[frost, split, rapid, shock]: split rides the shock that ends its cast, so its shards carry shock', () => {
    expect(children(['frost', 'split', 'rapid', 'shock'], 0).shards).toEqual([])
    const { round, shards } = children(['frost', 'split', 'rapid', 'shock'], 1)
    expect(round.projectile!.onHit?.status).toBe('electrified')
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(applies(s)).toEqual(['shock'])
      expect(s.projectile!.mods).toEqual([m('rapid'), m('shock'), m('split')])
    }
  })

  it('[split, frost]: the shards freeze (#119: they used to look icy and apply nothing)', () => {
    const { shards } = children(['split', 'frost'])
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(s.projectile!.onHit).toEqual({ status: 'frozen', ticks: 120 })
      expect(shows(s)).toEqual(['frost'])
    }
  })

  it('a shard that reaches a body freezes it', () => {
    const { w } = rig(['split', 'frost'])
    const first = body(w, 24, 20, 1)
    // The upper shard leaves ~(23.5, 20) at +0.45 rad.
    const reached = body(w, 23.5 + 2.5 * Math.cos(0.45), 20 + 2.5 * Math.sin(0.45))
    fire(w, 15)
    expect(first.dead).toBe(true)
    expect(reached.health!.hp).toBe(400 - 7)
    expect(statuses(reached)).toEqual(['frozen'])
  })

  it('[split, splinterShot, shock]: shards and shrapnel of one cast carry the same element', () => {
    const { shards, frags } = children(['split', 'splinterShot', 'shock'])
    expect(shards).toHaveLength(2)
    expect(frags).toHaveLength(4)
    for (const k of [...shards, ...frags]) expect(applies(k)).toEqual(['shock'])
  })

  it('[frost, split]: a trailing split is a bare cast, so its shards carry nothing and look it', () => {
    const { round, shards } = children(['frost', 'split'], 1)
    expect(round.projectile!.onHit).toBeUndefined()
    expect(shards).toHaveLength(2)
    for (const s of shards) {
      expect(s.projectile!.onHit).toBeUndefined()
      expect(shows(s)).toEqual([])
    }
  })

  it("a base weapon's own element is not a payload: a freeze ray's bare split cast freezes, its shards do not", () => {
    const { round, shards } = children(['split'], 0, 'freezeRay')
    expect(round.projectile!.onHit?.status).toBe('frozen')
    expect(shards).toHaveLength(2)
    for (const s of shards) expect(s.projectile!.onHit).toBeUndefined()
  })

  it('a stowed element past the live window rides nothing', () => {
    const { shards } = children(['split', 'rapid', 'heavy', 'overload', 'frost'])
    expect(shards).toHaveLength(2)
    for (const s of shards) expect(s.projectile!.onHit).toBeUndefined()
  })
})

describe("blasts carry the element that ends their round's cast", () => {
  it('[explosive, frost]: the blast freezes every body it damages, and names frost', () => {
    const { w } = rig(['explosive', 'frost'])
    const { pack, far } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast.element).toBe('frost')
    for (const b of pack) {
      expect(b.health!.hp).toBeLessThan(400)
      expect(statuses(b)).toEqual(['frozen'])
    }
    expect(far.health!.hp).toBe(400)
    expect(statuses(far)).toEqual([])
  })

  it('[frost, explosive, shock]: the second cast blasts shock', () => {
    const { w } = rig(['frost', 'explosive', 'shock'], 1)
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast.element).toBe('shock')
    for (const b of pack) expect(statuses(b)).toEqual(['electrified'])
  })

  it('[detonator, rapid, frost]: the kill blast freezes the pack', () => {
    const { w } = rig(['detonator', 'rapid', 'frost'])
    const { first, pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(first.dead).toBe(true)
    expect(blast.element).toBe('frost')
    for (const b of pack) {
      expect(b.health!.hp).toBe(400 - 24)
      expect(statuses(b)).toEqual(['frozen'])
    }
  })

  it('[frost, explosive]: a trailing explosive is a bare cast; its blast damages, applies nothing, names nothing', () => {
    const { w } = rig(['frost', 'explosive'], 1)
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast).toEqual({ type: 'explosion', x: blast.x, y: blast.y, radius: blast.radius })
    for (const b of pack) {
      expect(b.health!.hp).toBeLessThan(400)
      expect(statuses(b)).toEqual([])
    }
  })

  it("a freeze ray's bare explosive cast: the blast only damages", () => {
    const { w } = rig(['explosive'], 0, 'freezeRay')
    const { pack } = stage(w)
    const [blast] = blasts(fire(w))
    expect(blast.element).toBeUndefined()
    for (const b of pack) expect(statuses(b)).toEqual([])
  })

  it('a body the blast does not damage (i-frames) gains no element either', () => {
    const { w } = rig(['explosive', 'frost'])
    const { pack } = stage(w)
    const [guarded, ...rest] = pack
    guarded.health!.iframes = 30
    fire(w, 12)
    expect(guarded.health!.hp).toBe(400)
    expect(statuses(guarded)).toEqual([])
    for (const b of rest) expect(statuses(b)).toEqual(['frozen'])
  })

  it('the shooter caught in its own blast takes the element with the damage', () => {
    const { w, p } = rig(['explosive', 'incendiary'])
    body(w, 21.2, 20)
    p.health!.iframes = 0
    const hp = p.health!.hp
    fire(w, 1)
    expect(p.health!.hp).toBeLessThan(hp)
    expect(statuses(p)).toEqual(['burning'])
  })
})

describe('a carried element does what that element does (#92 verbs)', () => {
  it('[explosive, rapid, incendiary]: the blast sets the pack burning and panicking, lit by the shooter', () => {
    const { w, p } = rig(['explosive', 'rapid', 'incendiary'])
    body(w, 24, 20, 1)
    const pack = [spawnNpc(w, 'thug', 24.8, 20.9), spawnNpc(w, 'thug', 24.8, 19.1), spawnNpc(w, 'thug', 23.4, 21.1)]
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]]))
    for (let i = 0; i < 20 && !blasts(w.events).length; i++) tickWorld(w, new Map([[0, emptyInput()]]))
    expect(blasts(w.events)[0].element).toBe('incendiary')
    for (const t of pack) {
      expect(t.health!.hp).toBeLessThan(t.health!.max)
      expect(statuses(t)).toEqual(['burning'])
      expect(isPanicking(w, t)).toBe(true)
      expect(t.fx!.burning.source).toBe(p.id)
    }
  })

  it('[split, rapid, shock]: a shard carrying shock stuns what it reaches and leaps to the next NPC', () => {
    const { w, p } = rig(['split', 'rapid', 'shock'])
    const first = body(w, 24, 20, 1)
    const reached = spawnNpc(w, 'thug', 23.5 + 2.5 * Math.cos(0.45), 20 + 2.5 * Math.sin(0.45))
    reached.health!.hp = reached.health!.max = 400
    const beside = spawnNpc(w, 'thug', reached.pos.x + 0.6, reached.pos.y + 1.4)
    const events = fire(w, 12)
    expect(first.dead).toBe(true)
    expect(reached.health!.hp).toBeLessThan(400)
    expect(statuses(reached)).toEqual(['electrified'])
    expect(statuses(beside)).toEqual(['electrified'])
    expect(beside.health!.hp).toBe(beside.health!.max)
    expect(events).toContainEqual(expect.objectContaining({ type: 'shock', targetId: beside.id }))
    expect(p.fx?.electrified).toBeUndefined()
  })
})

describe('determinism', () => {
  // Shotgun: two casts per pull, so one pull fires a burning split cast and a
  // shock splinter cast side by side.
  const FIGHT = ['split', 'incendiary', 'splinterShot', 'shock']
  const burst = (t: number): Map<number, InputCmd> =>
    new Map([[0, { ...emptyInput(), seq: t, attack: t % 3 !== 0, aimX: 1, aimY: Math.sin(t * 0.3) * 0.4 }]])

  const fight = (): World => {
    const { w } = rig(FIGHT, 0, 'shotgun')
    stage(w)
    for (let i = 0; i < 6; i++) body(w, 22 + i * 0.9, 18 + (i % 3) * 2, 60)
    return w
  }

  it('a fight serialized with element-carrying rounds in flight replays byte for byte', () => {
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

describe('the cast is read from the stored cast index', () => {
  it('pulling through [frost, split, rapid, shock] walks cast 1 then cast 2', () => {
    const { w, p } = rig(['frost', 'split', 'rapid', 'shock'])
    const pulls: string[][] = []
    for (let k = 0; k < 2; k++) {
      for (const e of w.entities) if (e.kind === 'projectile') e.dead = true
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
      pulls.push(w.entities.filter((e) => e.kind === 'projectile' && e !== round).flatMap(applies))
    }
    expect(pulls).toEqual([[], ['shock', 'shock']])
    expect(weaponStack(p)!.castIndex).toBe(0)
  })
})
