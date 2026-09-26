// Primer/Striker prototype (design A): adversarial tests through the real
// systems. Every test sets the world exactly, drives `tickWorld` with the same
// InputCmd fields a player sends, and asserts on the resulting world.

import { describe, expect, it } from 'vitest'
import { heldCmd, parseHeldInput, runVerb } from '../../debug/verbs'
import { floorDraftOffer, weightedModId } from './draft'
import { MODS, POOLED_MODS } from '../data/mods'
import { ARC_DAMAGE, CHAIN_RADIUS, CRACK_MULT, EJECT_NOGRAB_TICKS, SPARK_ZAP } from '../data/reactions'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { mulberry32 } from '../rng'
import { applyScenario } from '../scenarios'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual } from '../testkit'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { packModSwap } from './modSequence'
import { FLOOR_SLOT, PRIMER_BASE, primerStack } from './primer'
import { hasStatus } from './statusFx'
import { weaponStack } from './inventory'

// ── Arena ────────────────────────────────────────────────────────────────────

/** Top-left of an open rw×rh block of floor (a real generated level). */
const openRect = (w: World, rw: number, rh: number): { x: number; y: number } => {
  for (let y = 1; y + rh < w.level.h; y++) {
    for (let x = 1; x + rw < w.level.w; x++) {
      let ok = true
      for (let j = 0; j < rh && ok; j++) for (let i = 0; i < rw && ok; i++) if (isSolidTile(w.level, x + i, y + j)) ok = false
      if (ok) return { x, y }
    }
  }
  throw new Error('no open rect')
}

interface Arena {
  w: World
  p: Entity
  /** Arena origin: a 16×9 open block; the player stands at (ox+2, oy+4). */
  ox: number
  oy: number
}

/** A Primer/Striker world with one player on the west edge of an open block,
 * no other NPCs, and the guns set exactly. */
const arena = (striker: WeaponMod[] = [], primer: WeaponMod[] = [{ id: 'soak', stacks: 1 }], seed = 7): Arena => {
  const w = createWorld(seed, 1)
  w.primerStriker = true
  w.modCasting = 'sequence'
  const { x: ox, y: oy } = openRect(w, 16, 9)
  const p = spawnPlayer(w, 0, ox + 2.5, oy + 4.5)
  p.health!.iframes = 0
  weaponStack(p)!.mods = striker.map((m) => ({ ...m }))
  primerStack(p)!.mods = primer.map((m) => ({ ...m }))
  return { w, p, ox, oy }
}

/** A still, AI-less target body (like the stage bystanders). */
const dummy = (w: World, x: number, y: number, hp = 200, resist?: Record<string, number>): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.speed = 2
  if (resist) e.resist = { ...resist }
  return e
}

const aimAt = (p: Entity, t: Entity): { aimX: number; aimY: number } => {
  const dx = t.pos.x - p.pos.x
  const dy = t.pos.y - p.pos.y
  const l = Math.hypot(dx, dy)
  return { aimX: dx / l, aimY: dy / l }
}

/** Hold `cmd` for `n` ticks, re-aiming at `target` each tick. Edge fields
 * (modSwap) ride the first tick only, like the input layer. */
const hold = (w: World, p: Entity, n: number, cmd: Partial<InputCmd>, target?: Entity): string[] => {
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    const c: InputCmd = { ...emptyInput(), ...cmd, seq: i, ...(target ? aimAt(p, target) : {}) }
    if (i > 0) delete c.modSwap
    tickWorld(w, new Map([[0, c]]))
    for (const ev of w.events) if (ev.type === 'reaction') names.push(ev.name)
  }
  return names
}

const wetIt = (w: World, e: Entity): void => {
  e.fx = { ...(e.fx ?? {}), wet: { until: w.tick + 1000 } }
}

// ── Flag off ─────────────────────────────────────────────────────────────────

describe('primerStriker: flag off is the untouched path', () => {
  const run = (seed: number, sequence: boolean, withPrototypeInputs: boolean): World => {
    const w = createWorld(seed, 1)
    if (sequence) w.modCasting = 'sequence'
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    p.loadout!.inventory[0].mods = [
      { id: 'shock', stacks: 1 },
      { id: 'pierce', stacks: 1 },
    ]
    for (let t = 1; t <= 240; t++) {
      const a = t * 0.05
      const cmd: InputCmd = { ...emptyInput(), seq: t, attack: true, aimX: Math.cos(a), aimY: Math.sin(a) }
      if (withPrototypeInputs) {
        cmd.prime = true
        if (t % 29 === 0) cmd.modSwap = packModSwap(t % 2, FLOOR_SLOT) // an eject request
        if (t % 31 === 0) cmd.modSwap = packModSwap(0, PRIMER_BASE) // a cross-gun request
      }
      tickWorld(w, new Map([[0, cmd]]))
    }
    return w
  }

  it('a player gets no Primer unless the world has the rule', () => {
    const w = createWorld(3, 1)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    expect(primerStack(p)).toBeUndefined()
    expect(p.loadout!.inventory.map((s) => s.itemId)).toEqual(['pistol'])
  })

  for (const sequence of [false, true]) {
    it(`prime / eject / cross-gun inputs are inert without the rule (sequencing ${sequence ? 'on' : 'off'})`, () => {
      expectWorldEqual(run(5, sequence, true), run(5, sequence, false))
    })
  }

  for (const sequence of [false, true]) {
    it(`Spark / Flame / plain rounds on coated bodies behave exactly as on main without the rule (sequencing ${sequence ? 'on' : 'off'})`, () => {
      const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }, { id: 'pierce', stacks: 3 }])
      delete w.primerStriker
      if (!sequence) delete w.modCasting
      p.loadout!.inventory = p.loadout!.inventory.filter((s) => s.itemId !== 'primerLobber')
      const line = [dummy(w, ox + 6.5, oy + 4.5, 500, { physical: 1, electrified: 2 }), dummy(w, ox + 7.5, oy + 4.5, 500, { physical: 1 })]
      line[0].fx = { wet: { until: 10_000 }, oiled: { until: 10_000 }, rimed: { until: 10_000 }, magnetised: { until: 10_000 } }
      line[1].fx = { wet: { until: 10_000 }, magnetised: { until: 10_000 } }
      const names = hold(w, p, 40, { attack: true, prime: true }, line[0])
      expect(names).toEqual([])
      expect(w.events.some((e) => e.type === 'reaction')).toBe(false)
      // Only whole pistol rounds landed: no zap, no arc, no crack, no wildfire.
      for (const e of line) expect((500 - e.health!.hp) % 14).toBe(0)
      expect(hasStatus(line[0], 'wet') && hasStatus(line[0], 'oiled') && hasStatus(line[0], 'rimed')).toBe(true)
      expect(line[0].pos.x).toBeCloseTo(ox + 6.5, 0) // no magnet drift
    })
  }

  it('the prototype mod never enters the draft hand or the scattered-pickup roll', () => {
    expect(POOLED_MODS.map((m) => m.id)).toEqual(Object.keys(MODS).filter((id) => id !== 'soak'))
    for (let seed = 0; seed < 200; seed++) {
      for (let floor = 1; floor <= 4; floor++) expect(floorDraftOffer(seed, floor)).not.toContain('soak')
      const rng = mulberry32(seed)
      for (let i = 0; i < 20; i++) expect(weightedModId(rng)).not.toBe('soak')
    }
  })

  it('a world without the rule serializes with no primerStriker key; one with it round-trips', () => {
    const w = createWorld(9, 1)
    expect('primerStriker' in serializeWorld(w)).toBe(false)
    w.primerStriker = true
    expect(deserializeWorld(serializeWorld(w)).primerStriker).toBe(true)
  })
})

// ── The Primer ───────────────────────────────────────────────────────────────

describe('the Primer (second trigger)', () => {
  it('fires on `prime` alone, deals no damage, and coats the body it bursts on', () => {
    const { w, p, ox, oy } = arena()
    const t = dummy(w, ox + 7.5, oy + 4.5)
    const names = hold(w, p, 30, { prime: true }, t)
    expect(names).toContain('coat.soak')
    expect(t.health!.hp).toBe(200)
    expect(hasStatus(t, 'wet')).toBe(true)
  })

  it('both triggers fire on the same tick, each on its own clock', () => {
    const { w, p, ox, oy } = arena()
    const t = dummy(w, ox + 12.5, oy + 4.5)
    hold(w, p, 1, { prime: true, attack: true }, t)
    const shots = w.entities.filter((e) => e.projectile && e.projectile.ownerId === p.id)
    expect(shots.filter((s) => s.projectile!.prime).length).toBe(1)
    expect(shots.filter((s) => !s.projectile!.prime).length).toBe(1)
  })

  it('never coats a player, so a Striker can never arc through a teammate', () => {
    const { w, p, ox, oy } = arena()
    const mate = spawnPlayer(w, 1, ox + 6.5, oy + 4.5)
    hold(w, p, 30, { prime: true }, mate)
    expect(hasStatus(mate, 'wet')).toBe(false)
  })

  it('explosive widens the splash: a spread row is all coated by one glob', () => {
    const { w, p, ox, oy } = arena([], [{ id: 'explosive', stacks: 1 }, { id: 'soak', stacks: 1 }])
    const row = [dummy(w, ox + 8.5, oy + 2.5), dummy(w, ox + 8.5, oy + 4.5), dummy(w, ox + 8.5, oy + 6.5)]
    hold(w, p, 30, { prime: true }, row[1])
    expect(row.every((e) => hasStatus(e, 'wet'))).toBe(true)
  })

  it('an empty Primer or one holding only modifiers is harmless (no crash, no coat)', () => {
    for (const mods of [[], [{ id: 'pierce', stacks: 1 }], [{ id: 'nope', stacks: 1 }], [{ id: 'soak', stacks: 0 }]] as WeaponMod[][]) {
      const { w, p, ox, oy } = arena([], mods)
      const t = dummy(w, ox + 6.5, oy + 4.5)
      hold(w, p, 40, { prime: true }, t)
      expect(t.fx?.wet).toBeUndefined()
      expect(t.health!.hp).toBe(200)
    }
  })

  it('the Primer recharges after it wraps: holding it cannot machine-gun globs', () => {
    const { w, p, ox, oy } = arena()
    const t = dummy(w, ox + 14.5, oy + 4.5)
    let globs = 0
    for (let i = 0; i < 90; i++) {
      const before = new Set(w.entities.map((e) => e.id))
      hold(w, p, 1, { prime: true }, t)
      globs += w.entities.filter((e) => !before.has(e.id) && e.projectile?.prime).length
    }
    // [soak] wraps every pull: lobber recharge 40 → at most 3 globs in 90 ticks.
    expect(globs).toBeGreaterThanOrEqual(2)
    expect(globs).toBeLessThanOrEqual(3)
  })
})

// ── Reactions ────────────────────────────────────────────────────────────────

describe('reactions (Striker verb on Primer coat)', () => {
  it('Soak + Spark floods a wet cluster and stops at a gap wider than the chain radius', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const a = dummy(w, ox + 7.5, oy + 4.5)
    const b = dummy(w, ox + 8.5, oy + 4.5)
    const c = dummy(w, ox + 9.5, oy + 4.5)
    const far = dummy(w, ox + 9.5 + CHAIN_RADIUS + 0.1, oy + 4.5)
    for (const e of [a, b, c, far]) wetIt(w, e)
    const names = hold(w, p, 30, { attack: true }, a)
    expect(names).toContain('arc')
    for (const e of [a, b, c]) {
      expect(e.health!.hp).toBeLessThan(200)
      expect(hasStatus(e, 'wet')).toBe(false) // the arc spent the water
    }
    expect(far.health!.hp).toBe(200)
    expect(hasStatus(far, 'wet')).toBe(true)
  })

  it('a Spark that KILLS the wet body it hits still arcs through the rest of the cluster', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const nearlyDead = dummy(w, ox + 7.5, oy + 4.5, 5)
    const b = dummy(w, ox + 8.5, oy + 4.5)
    const c = dummy(w, ox + 9.5, oy + 4.5)
    for (const e of [nearlyDead, b, c]) wetIt(w, e)
    const names = hold(w, p, 25, { attack: true }, nearlyDead)
    expect(nearlyDead.dead).toBe(true)
    expect(names).toContain('arc')
    expect(b.health!.hp).toBeLessThan(200)
    expect(c.health!.hp).toBeLessThan(200)
  })

  it('a dry target takes the Spark jolt but no arc', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const a = dummy(w, ox + 7.5, oy + 4.5, 200, { physical: 0 })
    const names = hold(w, p, 30, { attack: true }, a)
    expect(names).not.toContain('arc')
    expect(200 - a.health!.hp).toBe(SPARK_ZAP)
  })

  it('weak to lightning: resist.electrified 2 doubles every Spark source; 0 takes none but still conducts', () => {
    const run = (mult: number): { hit: number; next: number } => {
      const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
      const hit = dummy(w, ox + 7.5, oy + 4.5, 500, { physical: 0, electrified: mult })
      const next = dummy(w, ox + 8.5, oy + 4.5, 500, { physical: 0 })
      wetIt(w, hit)
      wetIt(w, next)
      hold(w, p, 30, { attack: true }, hit)
      return { hit: 500 - hit.health!.hp, next: 500 - next.health!.hp }
    }
    const neutral = run(1)
    const weak = run(2)
    const immune = run(0)
    expect(neutral.hit).toBe(SPARK_ZAP + ARC_DAMAGE)
    expect(weak.hit).toBe(2 * neutral.hit)
    expect(immune.hit).toBe(0)
    expect(immune.next).toBe(neutral.next) // the immune body still carried the arc
    expect(neutral.next).toBeGreaterThan(0)
  })

  it('Soak + Frost flash-freezes the wet cluster', () => {
    const { w, p, ox, oy } = arena([{ id: 'frost', stacks: 1 }])
    const a = dummy(w, ox + 7.5, oy + 4.5)
    const b = dummy(w, ox + 8.5, oy + 4.5)
    wetIt(w, a)
    wetIt(w, b)
    const names = hold(w, p, 25, { attack: true }, a)
    expect(names).toContain('flashFreeze')
    expect(hasStatus(b, 'frozen')).toBe(true)
  })

  it('Soak + Flame makes steam: no burn, and an NPC loses its target and stops', () => {
    const { w, p, ox, oy } = arena([{ id: 'incendiary', stacks: 1 }])
    const t = spawnNpc(w, 'thug', ox + 7.5, oy + 4.5)
    t.health!.iframes = 0
    wetIt(w, t)
    const names = hold(w, p, 20, { attack: true }, t)
    expect(names).toContain('steam')
    expect(hasStatus(t, 'burning')).toBe(false)
    expect(hasStatus(t, 'steamed')).toBe(true)
    const at = { ...t.pos }
    hold(w, p, 20, {}, t)
    expect(t.ai!.targetId).toBeUndefined()
    expect(Math.hypot(t.pos.x - at.x, t.pos.y - at.y)).toBeLessThan(0.05)
  })

  it('Oil + Flame spreads a wildfire through oiled bodies; Oil + Spark ignites', () => {
    for (const payload of ['incendiary', 'shock']) {
      const { w, p, ox, oy } = arena([{ id: payload, stacks: 1 }])
      const a = dummy(w, ox + 7.5, oy + 4.5)
      const b = dummy(w, ox + 8.5, oy + 4.5)
      for (const e of [a, b]) e.fx = { oiled: { until: w.tick + 1000 } }
      const names = hold(w, p, 25, { attack: true }, a)
      expect(names).toContain(payload === 'shock' ? 'ignite' : 'wildfire')
      expect(hasStatus(b, 'burning')).toBe(true)
      expect(hasStatus(b, 'oiled')).toBe(false)
    }
  })

  it('Oil + Frost fizzles: no freeze, and the oil stays for a teammate', () => {
    const { w, p, ox, oy } = arena([{ id: 'frost', stacks: 1 }])
    const a = dummy(w, ox + 7.5, oy + 4.5)
    a.fx = { oiled: { until: w.tick + 1000 } }
    const names = hold(w, p, 25, { attack: true }, a)
    expect(names).toContain('fizzle')
    expect(hasStatus(a, 'frozen')).toBe(false)
    expect(hasStatus(a, 'oiled')).toBe(true)
  })

  it('Rime + a plain round cracks: armour ignored, x CRACK_MULT, rime spent', () => {
    const { w, p, ox, oy } = arena([])
    const brute = dummy(w, ox + 7.5, oy + 4.5, 500, { physical: 0.35 })
    brute.fx = { rimed: { until: w.tick + 1000 } }
    const names = hold(w, p, 20, { attack: true }, brute)
    expect(names).toContain('crack')
    expect(500 - brute.health!.hp).toBe(14 * CRACK_MULT) // pistol 14, not 14*0.35
    expect(hasStatus(brute, 'rimed')).toBe(false)
  })

  it('a frozen rimed body shatters instead of cracking (no double multiplier)', () => {
    const { w, p, ox, oy } = arena([])
    const t = dummy(w, ox + 7.5, oy + 4.5, 500, { physical: 1 })
    t.fx = { rimed: { until: w.tick + 1000 }, frozen: { until: w.tick + 1000 } }
    const names = hold(w, p, 20, { attack: true }, t)
    expect(names).not.toContain('crack')
    expect(500 - t.health!.hp).toBe(14 * 5) // SHATTER_DAMAGE_MULT only
  })

  it('Magnet pulls a spread pair together within two seconds, then a verb hops between them', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const a = dummy(w, ox + 8.5, oy + 2.5)
    const b = dummy(w, ox + 8.5, oy + 6.5)
    for (const e of [a, b]) e.fx = { magnetised: { until: w.tick + 1000 } }
    hold(w, p, 60, {})
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeLessThan(CHAIN_RADIUS)
    const names = hold(w, p, 25, { attack: true }, a)
    expect(names).toContain('magnetHop')
    expect(b.health!.hp).toBeLessThan(200)
    expect(hasStatus(a, 'magnetised') || hasStatus(b, 'magnetised')).toBe(false)
  })

  it('a flood is capped: a 12-body wet line takes at most 6 arc hits', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const line = Array.from({ length: 12 }, (_, i) => dummy(w, ox + 5.5 + i, oy + 4.5, 500, { physical: 0 }))
    for (const e of line) wetIt(w, e)
    hold(w, p, 25, { attack: true }, line[0])
    expect(line.filter((e) => e.health!.hp < 500).length).toBe(6)
  })
})

// ── Swap, move, eject ────────────────────────────────────────────────────────

describe('the loadout swap input (both guns + the floor)', () => {
  const mods = (p: Entity): { s: string[]; pr: string[] } => ({
    s: (weaponStack(p)!.mods ?? []).map((m) => m.id),
    pr: (primerStack(p)!.mods ?? []).map((m) => m.id),
  })

  it('swaps across guns and starts BOTH guns recharging (no free reload)', () => {
    const { w, p } = arena([{ id: 'shock', stacks: 1 }, { id: 'pierce', stacks: 1 }], [{ id: 'soak', stacks: 1 }])
    hold(w, p, 1, { modSwap: packModSwap(0, PRIMER_BASE) })
    expect(mods(p)).toEqual({ s: ['soak', 'pierce'], pr: ['shock'] })
    expect(weaponStack(p)!.rechargeUntil).toBeGreaterThan(w.tick)
    expect(primerStack(p)!.rechargeUntil).toBeGreaterThan(w.tick)
  })

  it('an index past the end of a list moves the mod there', () => {
    const { w, p } = arena([{ id: 'shock', stacks: 1 }, { id: 'pierce', stacks: 1 }], [{ id: 'soak', stacks: 1 }])
    hold(w, p, 1, { modSwap: packModSwap(1, PRIMER_BASE + 9) })
    expect(mods(p)).toEqual({ s: ['shock'], pr: ['soak', 'pierce'] })
  })

  it('a swap inside one gun is the ordinary reorder and costs no recharge', () => {
    const { w, p } = arena([{ id: 'shock', stacks: 1 }, { id: 'pierce', stacks: 1 }])
    hold(w, p, 1, { modSwap: packModSwap(0, 1) })
    expect(mods(p).s).toEqual(['pierce', 'shock'])
    expect(weaponStack(p)!.rechargeUntil).toBeUndefined()
  })

  it('ignores garbage: same index, two empties, out of range, both floor, negative/huge/NaN', () => {
    const { w, p } = arena([{ id: 'shock', stacks: 1 }], [{ id: 'soak', stacks: 1 }])
    const before = JSON.stringify(serializeWorld(w).entities.find((e) => e.id === p.id))
    for (const v of [packModSwap(0, 0), packModSwap(5, 6), packModSwap(40, 0), packModSwap(FLOOR_SLOT, FLOOR_SLOT), packModSwap(9, FLOOR_SLOT), -1, 0x10000, Number.NaN, 1.5]) {
      hold(w, p, 1, { modSwap: v })
    }
    const after = serializeWorld(w).entities.find((e) => e.id === p.id)!
    expect((after.loadout as { inventory: { mods?: WeaponMod[] }[] }).inventory.map((s) => s.mods)).toEqual(
      (JSON.parse(before).loadout as { inventory: { mods?: WeaponMod[] }[] }).inventory.map((s) => s.mods),
    )
    expect(w.entities.some((e) => e.pickup)).toBe(false)
  })

  it('eject drops a live cartridge ahead; the dropper waits out the no-grab window, a teammate does not', () => {
    const { w, p } = arena([{ id: 'shock', stacks: 1 }], [{ id: 'soak', stacks: 1 }])
    p.facing = 0
    hold(w, p, 1, { modSwap: packModSwap(0, FLOOR_SLOT), aimX: 1, aimY: 0 })
    const cart = w.entities.find((e) => e.pickup?.itemId === 'shock')!
    expect(cart).toBeDefined()
    expect(mods(p).s).toEqual([])
    // Walk the dropper onto it: nothing until the window closes.
    p.pos = { ...cart.pos }
    hold(w, p, EJECT_NOGRAB_TICKS - 2, {})
    expect(cart.dead).toBeFalsy()
    hold(w, p, 3, {})
    expect(cart.dead).toBe(true)
    // It went into the Primer (room there), not back into the Striker.
    expect(mods(p)).toEqual({ s: [], pr: ['soak', 'shock'] })
  })

  it('a teammate standing on the drop grabs it at once', () => {
    const { w, p, ox, oy } = arena([{ id: 'frost', stacks: 1 }], [{ id: 'soak', stacks: 1 }])
    p.facing = 0
    const mate = spawnPlayer(w, 1, ox + 3.5, oy + 4.5)
    hold(w, p, 2, { modSwap: packModSwap(0, FLOOR_SLOT), aimX: 1, aimY: 0 })
    expect(w.entities.some((e) => e.pickup?.itemId === 'frost')).toBe(false)
    expect(primerStack(mate)!.mods!.map((m) => m.id)).toEqual(['soak', 'frost'])
  })

  it('eject a stacked mod drops one stack and keeps the rest', () => {
    const { w, p } = arena([{ id: 'heavy', stacks: 3 }])
    hold(w, p, 1, { modSwap: packModSwap(0, FLOOR_SLOT) })
    expect(weaponStack(p)!.mods).toEqual([{ id: 'heavy', stacks: 2 }])
    expect(w.entities.filter((e) => e.pickup?.itemId === 'heavy').length).toBe(1)
  })

  it('a full Primer sends a pickup to the Striker instead', () => {
    const { w, p } = arena([], [{ id: 'soak', stacks: 1 }, { id: 'pierce', stacks: 1 }, { id: 'explosive', stacks: 1 }])
    const c = addEntity(w, makeEntity('pickup', 'mod.frost', p.pos.x, p.pos.y, 0.3))
    c.pickup = { itemId: 'frost', qty: 1 }
    hold(w, p, 1, {})
    expect(weaponStack(p)!.mods!.map((m) => m.id)).toEqual(['frost'])
  })
})

// ── Determinism and the playtest surface ─────────────────────────────────────

describe('determinism and the step verb', () => {
  const script = (w: World, p: Entity, t: Entity): void => {
    hold(w, p, 1, { modSwap: packModSwap(0, PRIMER_BASE + 1) })
    hold(w, p, 40, { prime: true }, t)
    hold(w, p, 40, { attack: true, prime: true }, t)
  }

  it('a run split through serialize is byte-identical to one continuous run', () => {
    const build = (): Arena & { t: Entity } => {
      const a = arena([{ id: 'shock', stacks: 1 }, { id: 'frost', stacks: 1 }], [{ id: 'explosive', stacks: 1 }, { id: 'soak', stacks: 1 }])
      const t = spawnNpc(a.w, 'thug', a.ox + 8.5, a.oy + 4.5)
      spawnNpc(a.w, 'thug', a.ox + 9.5, a.oy + 4.5)
      return { ...a, t }
    }
    const one = build()
    script(one.w, one.p, one.t)
    hold(one.w, one.p, 60, { attack: true }, one.t)

    const two = build()
    script(two.w, two.p, two.t)
    const w2 = deserializeWorld(serializeWorld(two.w))
    hold(w2, w2.byId.get(two.p.id)!, 60, { attack: true }, w2.byId.get(two.t.id))
    expectWorldEqual(one.w, w2)
  })

  it('step accepts prime / swap / eject; swap and eject are first-tick-only', () => {
    const { w } = arena([{ id: 'shock', stacks: 1 }])
    const h = parseHeldInput(w, '{"prime":true,"swap":[0,16]}')
    expect(h.cmd.prime).toBe(true)
    expect(heldCmd(w, h, 0).modSwap).toBe(packModSwap(0, 16))
    expect(heldCmd(w, h, 1).modSwap).toBeUndefined()
    expect(heldCmd(w, h, 1).prime).toBe(true)
    expect(parseHeldInput(w, '{"eject":3}').cmd.modSwap).toBe(packModSwap(3, FLOOR_SLOT))
  })

  it('step rejects malformed prototype fields', () => {
    const { w } = arena()
    for (const bad of ['{"swap":[1]}', '{"swap":"0,1"}', '{"swap":[0,256]}', '{"eject":-1}', '{"eject":1.5}', '{"prime":"yes"}', '{"swap":[0,1],"eject":2}', '{"modSwap":1,"swap":[0,1]}']) {
      expect(() => parseHeldInput(w, bad), bad).toThrow()
    }
  })

  it('look shows both guns, their swap indices and the cast cycle', () => {
    const { w } = arena([{ id: 'pierce', stacks: 1 }, { id: 'shock', stacks: 1 }, { id: 'heavy', stacks: 1 }], [{ id: 'explosive', stacks: 1 }, { id: 'soak', stacks: 1 }])
    const look = JSON.parse(runVerb(w, 'look')) as { player: { striker: { mods: string[]; cycle: string[] }; primer: { mods: string[]; cycle: string[] } } }
    expect(look.player.striker.mods).toEqual(['0:pierce', '1:shock', '2:heavy'])
    expect(look.player.striker.cycle).toEqual(['SPARK +pierce', 'IMPACT +heavy'])
    expect(look.player.primer.mods).toEqual(['16:explosive', '17:soak'])
    expect(look.player.primer.cycle).toEqual(['SOAK splash 2.5 +explosive'])
  })

  it('step counts reactions by name', () => {
    const { w, p, ox, oy } = arena([{ id: 'shock', stacks: 1 }])
    const t = dummy(w, ox + 7.5, oy + 4.5)
    wetIt(w, t)
    dummy(w, ox + 8.5, oy + 4.5)
    wetIt(w, w.entities[w.entities.length - 1])
    const reply = JSON.parse(runVerb(w, `step 25 {"aimAt":${t.id},"attack":true}`)) as {
      events: Record<string, number>
      reached: Record<string, number>
    }
    expect(reply.events['reaction:arc']).toBe(1)
    expect(reply.reached.arc).toBe(2)
    void p
  })
})

// ── The scenarios ────────────────────────────────────────────────────────────

describe('scenarios', () => {
  it('primer: the spread pack does not chain, the magnet makes it chain', () => {
    const w = createWorld(7, 1)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    expect(applyScenario(w, 'primer')).toBe(true)
    expect(w.primerStriker).toBe(true)
    const p = w.entities.find((e) => e.playerCtl)!
    expect(weaponStack(p)!.mods!.map((m) => m.id)).toEqual(['pierce', 'shock', 'heavy'])
    expect(primerStack(p)!.mods!.map((m) => m.id)).toEqual(['explosive', 'soak'])
    const thugs = w.entities.filter((e) => e.archetype === 'thug')
    expect(thugs.length).toBe(9)
    expect(w.entities.some((e) => e.pickup?.itemId === 'shock')).toBe(true)
    // Every thug is inside the pistol's reach from where the player stands.
    for (const t of thugs) expect(Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y)).toBeLessThan(10)
  })

  it('primer-boss: the Mireclaw is weak to lightning and the Striker holds the hand of four', () => {
    const w = createWorld(202, 1)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    applyScenario(w, 'primer-boss')
    const boss = w.entities.find((e) => e.archetype === 'boss')!
    expect(boss.resist?.electrified).toBe(2)
    const p = w.entities.find((e) => e.playerCtl)!
    expect(weaponStack(p)!.mods!.map((m) => m.id).sort()).toEqual(['frost', 'incendiary', 'pierce', 'shock'])
    expect(Math.hypot(boss.pos.x - p.pos.x, boss.pos.y - p.pos.y)).toBeCloseTo(8)
  })
})
