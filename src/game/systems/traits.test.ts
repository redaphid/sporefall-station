// Player traits (the draft's YOU card). Each test sets the world exactly, runs
// the real systems, and compares a player holding the trait against the same
// scene without it, so a hook that stops firing turns the test red.

import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import { TRAITS } from '../data/traits'
import type { Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { arm, expectWorldEqual } from '../testkit'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { arbitrateGoal } from './behaviors'
import { applyDamage, detonate } from './combat'
import { hearGunfire } from './alarm'
import { applyAreaEffect } from './itemEffects'
import { applyStatus, hasStatus } from './statusFx'
import { nearestNoise } from './goals'
import { applyTraitPick, traitVerdict } from './traits'

/** An open 21x21 floor in the middle of a real level, so nothing walls a test in. */
const arena = (hostile = false): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1, 'normal', hostile)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 10; y <= cy + 10; y++)
    for (let x = cx - 10; x <= cx + 10; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

/** A player with no spawn grace, holding `traits`. */
const player = (w: World, id: number, x: number, y: number, traits: string[] = []): Entity => {
  const p = spawnPlayer(w, id, x, y)
  p.health = { hp: 100, max: 100, iframes: 0 }
  for (const t of traits) applyTraitPick(p, t)
  return p
}

const tick = (w: World, cmds: Record<number, Partial<InputCmd>> = {}, n = 1): void => {
  for (let i = 0; i < n; i++)
    tickWorld(w, new Map(Object.entries(cmds).map(([k, c]) => [Number(k), { ...emptyInput(), ...c }])))
}

describe('trait registry', () => {
  it('every trait is keyed by its id, stacks at least once, and has a one-line blurb', () => {
    for (const [key, t] of Object.entries(TRAITS)) {
      expect(t.id, key).toBe(key)
      expect(t.maxStacks, key).toBeGreaterThanOrEqual(1)
      expect(t.blurb.length, key).toBeLessThanOrEqual(60)
      expect(t.blurb, key).not.toMatch(/\d+ ?%|\+\d/) // verbs, not numbers
    }
  })

  it('every trait does something: at least one hook a system reads', () => {
    const hooks = ['immune', 'knockback', 'roll', 'shotNoise', 'ownBlastProof', 'meleeRetort', 'revive', 'taunt', 'sees'] as const
    for (const t of Object.values(TRAITS)) expect(hooks.some((h) => t[h] !== undefined), t.id).toBe(true)
  })

  it('every immunity names a status something can actually apply', () => {
    const known = new Set([...Object.keys(ELEMENTS), 'stun', 'sleep'])
    for (const t of Object.values(TRAITS)) for (const s of t.immune ?? []) expect(known.has(s), `${t.id}: ${s}`).toBe(true)
  })
})

describe('applyTraitPick — stack, cap, reject', () => {
  it('adds a new trait, stacks a stackable one to its cap, then refuses', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy)
    expect(applyTraitPick(p, 'softSteps')).toEqual({ stacks: 1, maxed: false })
    expect(applyTraitPick(p, 'softSteps')).toEqual({ stacks: 2, maxed: false })
    expect(applyTraitPick(p, 'softSteps')).toEqual({ stacks: 2, maxed: true })
    expect(applyTraitPick(p, 'anchor')).toEqual({ stacks: 1, maxed: false })
    expect(applyTraitPick(p, 'anchor')).toEqual({ stacks: 1, maxed: true })
    expect(p.playerCtl!.traits).toEqual([
      { id: 'softSteps', stacks: 2 },
      { id: 'anchor', stacks: 1 },
    ])
  })

  it('rejects an unknown trait and a body with no playerCtl', () => {
    const { w, cx, cy } = arena()
    expect(() => applyTraitPick(player(w, 0, cx, cy), 'wings')).toThrow(/unknown trait/)
    expect(() => applyTraitPick(spawnNpc(w, 'thug', cx, cy), 'anchor')).toThrow(/playerCtl/)
  })

  it('the verdict tells a held, maxed or solo-only trait apart from a live one', () => {
    expect(traitVerdict(undefined, 'anchor', 1)).toEqual({ kind: 'live' })
    expect(traitVerdict([{ id: 'anchor', stacks: 1 }], 'anchor', 1)).toEqual({ kind: 'inert', reason: 'you have it' })
    expect(traitVerdict([{ id: 'softSteps', stacks: 1 }], 'softSteps', 1)).toEqual({ kind: 'live' })
    expect(traitVerdict([{ id: 'softSteps', stacks: 2 }], 'softSteps', 1)).toEqual({ kind: 'inert', reason: 'you have it' })
    expect(traitVerdict(undefined, 'medicHands', 1)).toEqual({ kind: 'inert', reason: 'needs a teammate' })
    expect(traitVerdict(undefined, 'medicHands', 2)).toEqual({ kind: 'live' })
    expect(traitVerdict(undefined, 'taunt', 1)).toEqual({ kind: 'inert', reason: 'needs a teammate' })
  })
})

describe('traits serialize with the world', () => {
  it('a player with traits round-trips byte-identically and keeps acting on them', () => {
    const w = createWorld(1, 1, 'normal', false) // an uncarved level, so it can restore
    const at = playerSpawnPoint(w.level, 0)
    const p = player(w, 0, at.x, at.y, ['anchor', 'softSteps', 'softSteps'])
    const copy = deserializeWorld(serializeWorld(w))
    expectWorldEqual(w, copy)
    const q = copy.entities.find((e) => e.id === p.id)!
    expect(q.playerCtl!.traits).toEqual([
      { id: 'anchor', stacks: 1 },
      { id: 'softSteps', stacks: 2 },
    ])
    applyDamage(copy, q, 5, q.pos.x - 1, q.pos.y, 16, 0)
    expect(q.vel).toEqual({ x: 0, y: 0 })
  })

  it('a player who never took a trait carries no traits field at all', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy)
    expect('traits' in p.playerCtl!).toBe(false)
    expect(JSON.stringify(serializeWorld(w))).not.toContain('"traits"')
  })
})

describe('Fireproof — fire cannot catch on you', () => {
  const burn = (traits: string[]) => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy, traits)
    applyStatus(w, p, 'burning', ELEMENTS.burning.durationTicks, 0)
    tick(w, {}, 120)
    return { lost: 100 - p.health!.hp, burning: hasStatus(p, 'burning') }
  }

  it('a flamethrower-length burn gnaws a bare player and does nothing to a fireproof one', () => {
    const bare = burn([])
    expect(bare.burning).toBe(true)
    expect(bare.lost).toBeGreaterThan(5)
    expect(burn(['fireproof'])).toEqual({ lost: 0, burning: false })
  })

  it('taking Fireproof while on fire puts the fire out', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy)
    applyStatus(w, p, 'burning', 600, 0)
    applyTraitPick(p, 'fireproof')
    expect(hasStatus(p, 'burning')).toBe(false)
  })

  it('stops only fire: frost still holds a fireproof player', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy, ['fireproof'])
    applyStatus(w, p, 'frozen', 90, 0)
    expect(hasStatus(p, 'frozen')).toBe(true)
  })
})

describe('Anchor — hits cannot knock you around, but your roll is short', () => {
  it('a sledgehammer-weight blow shoves a bare player and leaves an anchored one planted', () => {
    const run = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx, cy, traits)
      applyDamage(w, p, 10, cx - 1, cy, 16, 0)
      tick(w, {}, 20)
      return p.pos.x - cx
    }
    expect(run([])).toBeGreaterThan(0.8)
    expect(run(['anchor'])).toBe(0)
  })

  it('a stun cannot land on an anchored player, and neither can a slip', () => {
    const { w, cx, cy } = arena()
    const bare = player(w, 0, cx, cy)
    const anchored = player(w, 1, cx + 3, cy, ['anchor'])
    for (const s of ['stun', 'slip']) {
      applyStatus(w, bare, s, 20, 0)
      applyStatus(w, anchored, s, 20, 0)
    }
    expect(bare.status!.stun).toBe(20)
    expect(anchored.status!.stun).toBe(0)
  })

  it('the roll covers half the ground, with the same i-frame window', () => {
    const roll = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx - 6, cy, traits)
      tick(w, { 0: { moveX: 1, roll: true } })
      const iframeTicks = p.playerCtl!.roll!.untilTick - w.tick
      tick(w, { 0: {} }, 30)
      return { dist: p.pos.x - (cx - 6), iframeTicks }
    }
    const bare = roll([])
    const anchored = roll(['anchor'])
    expect(anchored.iframeTicks).toBe(bare.iframeTicks)
    expect(bare.dist).toBeGreaterThan(4)
    expect(anchored.dist).toBeLessThan(bare.dist * 0.6)
    expect(anchored.dist).toBeGreaterThan(bare.dist * 0.4)
  })
})

describe('Static Skin — anything that hits you up close gets zapped', () => {
  const brawl = (traits: string[]) => {
    const { w, cx, cy } = arena(true)
    const p = player(w, 0, cx, cy, traits)
    const brute = spawnNpc(w, 'brute', cx + 1.2, cy)
    brute.health = { hp: 1e6, max: 1e6, iframes: 0 }
    let hitAt = -1
    for (let t = 0; t < 150 && hitAt < 0; t++) {
      tick(w, { 0: {} })
      if (w.events.some((e) => e.type === 'hit' && e.targetId === p.id)) hitAt = w.tick
    }
    return { w, p, brute, hitAt }
  }

  it('the brute that lands a claw on a static player is zapped on the same tick; on a bare player it is not', () => {
    const bare = brawl([])
    expect(bare.hitAt).toBeGreaterThan(0)
    expect(hasStatus(bare.brute, 'electrified')).toBe(false)
    const zapped = brawl(['staticSkin'])
    expect(zapped.hitAt).toBeGreaterThan(0)
    expect(hasStatus(zapped.brute, 'electrified')).toBe(true)
  })

  it('a blow the player rolls through lands nothing, so nothing is zapped', () => {
    const { w, cx, cy } = arena(true)
    const p = player(w, 0, cx, cy, ['staticSkin'])
    const brute = spawnNpc(w, 'brute', cx + 1.2, cy)
    p.playerCtl!.roll = { untilTick: w.tick + 1000, cooldownUntilTick: w.tick + 1000, dirX: 0, dirY: 1 }
    p.speed = 0
    for (let t = 0; t < 60; t++) tick(w, { 0: {} })
    expect(w.events.filter((e) => e.type === 'hit' && e.targetId === p.id)).toEqual([])
    expect(hasStatus(brute, 'electrified')).toBe(false)
  })

  it('a bullet is not a blow up close: the shooter is never zapped', () => {
    const { w, cx, cy } = arena(true)
    const p = player(w, 0, cx, cy, ['staticSkin'])
    const gunner = spawnNpc(w, 'thug', cx + 5, cy)
    arm(gunner, 'pistol')
    gunner.health = { hp: 1e6, max: 1e6, iframes: 0 }
    let hurt = false
    for (let t = 0; t < 200 && !hurt; t++) {
      tick(w, { 0: {} })
      hurt = p.health!.hp < 100
      p.health!.iframes = 0
    }
    expect(hurt).toBe(true)
    expect(hasStatus(gunner, 'electrified')).toBe(false)
  })
})

describe('Blastproof — your own explosions cannot hurt you', () => {
  it('your blast at your feet leaves you whole; a bare player takes it', () => {
    const blast = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx, cy, traits)
      detonate(w, cx + 0.5, cy, 2, 30, p.id)
      return 100 - p.health!.hp
    }
    expect(blast([])).toBe(30)
    expect(blast(['blastproof'])).toBe(0)
  })

  it('only your own: a teammate’s blast, or a stranger’s, still hurts', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy, ['blastproof'])
    const mate = player(w, 1, cx + 1, cy)
    detonate(w, cx + 0.5, cy, 2, 30, mate.id)
    expect(p.health!.hp).toBe(70)
    expect(mate.health!.hp).toBe(70)
  })

  it('a thrown grenade you land at your own feet skips you too', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy, ['blastproof'])
    const e = spawnNpc(w, 'thug', cx + 1, cy)
    e.health = { hp: 1000, max: 1000, iframes: 0 }
    applyAreaEffect(w, cx + 0.5, cy, { kind: 'explode', radius: 2, damage: 25 }, p.id)
    expect(p.health!.hp).toBe(100)
    expect(e.health!.hp).toBe(975)
  })
})

describe('Soft Steps — enemies hear your shots from half as far', () => {
  const witness = (w: World, x: number, y: number) => {
    const civ = spawnNpc(w, 'civilian', x, y)
    civ.ai!.faction = 'civ'
    return civ
  }

  it('a crew member 8 tiles off hears a bare shot and raises heat; a soft shot passes unheard', () => {
    const heat = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx, cy, traits)
      witness(w, cx + 8, cy)
      hearGunfire(w, p, 10)
      return w.mission.heat ?? 0
    }
    expect(heat([])).toBe(10)
    expect(heat(['softSteps'])).toBe(0)
  })

  it('a witness close by still hears a soft shot', () => {
    const { w, cx, cy } = arena()
    const p = player(w, 0, cx, cy, ['softSteps'])
    witness(w, cx + 4, cy)
    hearGunfire(w, p, 10)
    expect(w.mission.heat).toBe(10)
  })

  it('a sleeping pod 5 tiles off wakes to a bare pistol and sleeps through a soft one (real fire path)', () => {
    const wakes = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx, cy, traits)
      arm(p, 'pistol')
      const pod = spawnNpc(w, 'pod', cx, cy + 5)
      pod.ai!.wakeOn = ['noise']
      pod.health = { hp: 1e6, max: 1e6, iframes: 0 }
      tick(w, { 0: { attack: true, aimX: 0, aimY: -1 } }, 20) // firing away from the pod
      return !pod.ai!.dormant
    }
    expect(wakes([])).toBe(true)
    expect(wakes(['softSteps'])).toBe(false)
  })

  it('a guard 8 tiles off comes to investigate a bare shot, not a soft one', () => {
    const heard = (traits: string[]) => {
      const { w, cx, cy } = arena()
      const p = player(w, 0, cx, cy, traits)
      const guard = spawnNpc(w, 'cop', cx + 8, cy)
      hearGunfire(w, p, 1)
      return nearestNoise(w, guard)
    }
    expect(heard([])).toBeDefined()
    expect(heard(['softSteps'])).toBeUndefined()
  })

  it('two stacks carry a quarter as far, and a soft shot never quiets a louder noise on the same spot', () => {
    const { w, cx, cy } = arena()
    const soft2 = player(w, 0, cx, cy, ['softSteps', 'softSteps'])
    hearGunfire(w, soft2, 1)
    expect(w.noises).toEqual([expect.objectContaining({ reach: 0.25 })])
    const loud = player(w, 1, cx + 0.5, cy)
    hearGunfire(w, loud, 1)
    expect(w.noises).toHaveLength(1)
    expect('reach' in w.noises[0]).toBe(false)
    hearGunfire(w, soft2, 1)
    expect('reach' in w.noises[0]).toBe(false)
  })
})

describe('Medic Hands — pick up a downed friend twice as fast, from twice as far', () => {
  const rescue = (gap: number, traits: string[]) => {
    const { w, cx, cy } = arena()
    const down = player(w, 0, cx, cy)
    player(w, 1, cx + gap, cy, traits)
    down.health!.hp = 0
    down.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    for (let t = 1; t <= 200; t++) {
      tick(w, {})
      if (!down.playerCtl!.downed) return t
    }
    return -1
  }

  it('beside the body: a medic takes half the time', () => {
    const bare = rescue(1, [])
    const medic = rescue(1, ['medicHands'])
    expect(bare).toBeGreaterThan(80)
    expect(medic).toBeLessThanOrEqual(Math.ceil(bare / 2))
  })

  it('two tiles off: a bare teammate cannot reach, a medic can', () => {
    expect(rescue(2, [])).toBe(-1)
    expect(rescue(2, ['medicHands'])).toBeGreaterThan(0)
  })

  it('out past the medic reach nobody revives', () => {
    expect(rescue(2.7, ['medicHands'])).toBe(-1)
  })
})

describe('Taunt — enemies that see you pick you over your friends', () => {
  const target = (traits: string[]) => {
    const { w, cx, cy } = arena(true)
    const near = player(w, 0, cx - 2, cy)
    const far = player(w, 1, cx + 4, cy, traits)
    const thug = spawnNpc(w, 'thug', cx, cy)
    thug.ai!.mode = 'aggro'
    return { goal: arbitrateGoal(w, thug), near: near.id, far: far.id }
  }

  it('a thug between two players goes for the nearer one, unless the farther one taunts', () => {
    const bare = target([])
    expect(bare.goal.target).toBe(bare.near)
    const taunted = target(['taunt'])
    expect(taunted.goal.target).toBe(taunted.far)
  })

  it('a taunt does not start a fight: an NPC that would not fight you still does not', () => {
    const { w, cx, cy } = arena(false)
    player(w, 0, cx + 2, cy, ['taunt'])
    const civ = spawnNpc(w, 'civilian', cx, cy)
    expect(['battle', 'pursue']).not.toContain(arbitrateGoal(w, civ).code)
  })
})
