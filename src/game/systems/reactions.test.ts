// Design B's reactive wands, through the REAL systems: every case builds exact
// world state, round-trips it through WorldJson, fires the player's actual
// weapon with InputCmds through tickWorld, and asserts on hp, statuses and
// events. The targets are still bodies (no AI) so a round's flight is exact.

import { describe, expect, it } from 'vitest'
import { THERMAL_CRACK_DAMAGE } from '../data/reactions'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { mulberry32 } from '../rng'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm, expectWorldEqual } from '../testkit'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { addEntity, createWorld, isBlocked, tickWorld, type ModCasting, type World } from '../world'
import { floorDraftOffer, weightedModId } from './draft'
import { wet } from './interactions'
import { weaponStack } from './inventory'
import { packModSwap } from './modSequence'
import { SHATTER_DAMAGE_MULT } from './combat'
import { CHIP_ARM_TICKS, POCKET } from './wandChips'
import { hasStatus } from './statusFx'

const PISTOL = 14
const ELEC = 20
const HP = 200

/** First row with 12 open tiles, and open rows 2 above and below, so a lane of
 * targets and a wet cluster beside it all stand on open floor. */
const openLane = (w: World): { x: number; y: number } => {
  for (let y = 3; y < w.level.h - 3; y++) {
    for (let x = 2; x < w.level.w - 14; x++) {
      let ok = true
      for (let dy = -2; dy <= 2 && ok; dy++) for (let i = 0; i < 12 && ok; i++) if (isBlocked(w, x + i, y + dy)) ok = false
      if (ok) return { x, y }
    }
  }
  throw new Error('no open lane')
}

interface Rig {
  w: World
  p: Entity
  lane: { x: number; y: number }
}

const rig = (mods: string[], casting: ModCasting | undefined = 'reactive'): Rig => {
  const w = createWorld(1, 1)
  if (casting) w.modCasting = casting
  const lane = openLane(w)
  const p = spawnPlayer(w, 0, lane.x + 0.5, lane.y + 0.5)
  p.health!.iframes = 0
  p.loadout!.inventory = []
  arm(p, 'pistol').mods = mods.map((id): WeaponMod => ({ id, stacks: 1 }))
  p.facing = 0
  return { w, p, lane }
}

/** A still body `dx` tiles east of the player (and `dy` off the firing line). */
const body = (r: Rig, dx: number, dy = 0, hp = HP, resist?: Record<string, number>): Entity => {
  const e = addEntity(r.w, makeEntity('npc', 'civilian', r.lane.x + 0.5 + dx, r.lane.y + 0.5 + dy))
  e.health = { hp, max: hp, iframes: 0 }
  if (resist) e.resist = resist
  return e
}

/** Round-trip the world through WorldJson: each case starts from exact, serialized state. */
const exact = (r: Rig): Rig => {
  const w = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(r.w))))
  return { w, p: w.byId.get(r.p.id)!, lane: r.lane }
}

const cmd = (c: Partial<InputCmd> = {}): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), ...c }]])

/** Tick `n` times with the same command, collecting every event. */
const run = (w: World, n: number, c: Partial<InputCmd> = {}): SimEvent[] => {
  const out: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, cmd(c))
    out.push(...w.events)
  }
  return out
}

/** One trigger pull (cooldown cleared), then time for the round to land. */
const pull = (r: Rig, settle = 14): SimEvent[] => {
  r.p.combat!.cooldown = 0
  return [...run(r.w, 1, { attack: true }), ...run(r.w, settle)]
}

const reactions = (evs: SimEvent[]): string[] => evs.flatMap((e) => (e.type === 'reaction' ? [e.reaction] : []))
const hp = (e: Entity): number => e.health!.hp
const stack = (p: Entity) => weaponStack(p)!
const pickups = (w: World): Entity[] => w.entities.filter((e) => e.pickup && !e.dead)

describe('reaction table through the real hit path', () => {
  it('Soak then Shock: ZAP CHAIN floods the wet cluster and only the wet cluster', () => {
    const setup = rig(['soak', 'shock'])
    const a = body(setup, 3)
    const b = body(setup, 3, 1.2) // wet neighbour, within the 1.6 arc radius
    const dry = body(setup, 3, -1.2) // neighbour, but dry: a dead end
    const far = body(setup, 6.5, 1.2) // wet, but 3.5 from the cluster: out of the arc's reach
    wet(setup.w, b)
    wet(setup.w, far)
    const r = exact(setup)
    const [A, B, D, F] = [a, b, dry, far].map((e) => r.w.byId.get(e.id)!)
    expect(reactions(pull(r))).toEqual([]) // soak lands plainly
    expect(hasStatus(A, 'wet')).toBe(true)
    const evs = pull(r)
    expect(reactions(evs)).toEqual(['chain'])
    expect(hp(A)).toBe(HP - PISTOL - PISTOL - ELEC)
    expect(hp(B)).toBe(HP - ELEC)
    expect(hp(D)).toBe(HP)
    expect(hp(F)).toBe(HP)
    expect(hasStatus(B, 'electrified')).toBe(true)
    expect(hasStatus(D, 'electrified')).toBe(false) // the arc only jumps between wet bodies
  })

  it('weak to lightning: the chain reads resist.electrified (2x, and 0 still conducts)', () => {
    const setup = rig(['soak', 'shock'])
    const a = body(setup, 3, 0, HP, { electrified: 2 })
    const immune = body(setup, 3, 1.2, HP, { electrified: 0 })
    const beyond = body(setup, 3, 2.4) // reached only THROUGH the immune body
    wet(setup.w, immune)
    wet(setup.w, beyond)
    const r = exact(setup)
    pull(r)
    pull(r)
    expect(hp(r.w.byId.get(a.id)!)).toBe(HP - 2 * PISTOL - 2 * ELEC)
    expect(hp(r.w.byId.get(immune.id)!)).toBe(HP)
    expect(hp(r.w.byId.get(beyond.id)!)).toBe(HP - ELEC)
  })

  it('Soak then Fire: FIZZLE, no burn, the water boils off, impact damage only', () => {
    const r = exact((() => { const s = rig(['soak', 'incendiary']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r)
    const evs = pull(r)
    expect(reactions(evs)).toEqual(['fizzle'])
    expect(hasStatus(t, 'burning')).toBe(false)
    expect(hasStatus(t, 'wet')).toBe(false)
    expect(hp(t)).toBe(HP - 2 * PISTOL)
    // And the fire never comes back: a burn would tick hp down over time.
    run(r.w, 60)
    expect(hp(t)).toBe(HP - 2 * PISTOL)
  })

  it('order is the verb: Fire then Soak is no fizzle (the body burns AND gets wet)', () => {
    const r = exact((() => { const s = rig(['incendiary', 'soak']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r)
    const evs = pull(r)
    expect(reactions(evs)).toEqual([])
    expect(hasStatus(t, 'burning')).toBe(true)
    expect(hasStatus(t, 'wet')).toBe(true)
  })

  it('Frost then Fire: THERMAL CRACK, no shatter, the ice becomes water', () => {
    const r = exact((() => { const s = rig(['frost', 'incendiary']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r)
    expect(hasStatus(t, 'frozen')).toBe(true)
    const evs = pull(r)
    expect(reactions(evs)).toEqual(['thermalCrack'])
    expect(evs.some((e) => e.type === 'shatter')).toBe(false)
    expect(hasStatus(t, 'frozen')).toBe(false)
    expect(hasStatus(t, 'wet')).toBe(true)
    expect(hasStatus(t, 'burning')).toBe(false) // the fire went into the thaw
    expect(hp(t)).toBe(HP - 2 * PISTOL - THERMAL_CRACK_DAMAGE)
  })

  it('the Crack re-primes: Frost, Fire, Shock chains off the meltwater', () => {
    const r = exact((() => { const s = rig(['frost', 'incendiary', 'shock']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    const seen = [...pull(r), ...pull(r), ...pull(r)]
    expect(reactions(seen)).toEqual(['thermalCrack', 'chain'])
    expect(hp(t)).toBe(HP - 3 * PISTOL - THERMAL_CRACK_DAMAGE - ELEC)
  })

  it('Frost then a BARE Heavy shatters (the only way to shatter)', () => {
    const r = exact((() => { const s = rig(['frost', 'heavy']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r) // frost
    const evs = pull(r) // heavy rides no payload: a bare cast, then the wand wraps
    expect(reactions(evs)).toEqual(['shatter'])
    expect(hp(t)).toBe(HP - PISTOL - (PISTOL + 4) * SHATTER_DAMAGE_MULT)
    expect(hasStatus(t, 'frozen')).toBe(false)
  })

  it('Frost then Shock is NUMB: the ice holds, no shatter, no stun, impact only', () => {
    const r = exact((() => { const s = rig(['frost', 'shock']); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r)
    const evs = pull(r)
    expect(reactions(evs)).toEqual(['numb'])
    expect(hasStatus(t, 'frozen')).toBe(true)
    expect(hasStatus(t, 'electrified')).toBe(false)
    expect(hp(t)).toBe(HP - 2 * PISTOL)
  })

  it('flag OFF: the same Frost-then-Fire wand shatters and burns, exactly as before', () => {
    const r = exact((() => { const s = rig(['frost', 'incendiary'], 'sequence'); body(s, 3); return s })())
    const t = r.w.entities.find((e) => e.kind === 'npc')!
    pull(r)
    const evs = pull(r)
    expect(reactions(evs)).toEqual([])
    const blows = evs.flatMap((e) => (e.type === 'hit' ? [e.amount] : []))
    expect(blows[0]).toBe(PISTOL * SHATTER_DAMAGE_MULT) // the element-bearing round shattered
    expect(hasStatus(t, 'burning')).toBe(true)
  })

  it('flag OFF: soak on a wet body then shock does NOT chain (the chain is reactive-only)', () => {
    const s = rig(['shock'], 'sequence')
    const t = body(s, 3)
    wet(s.w, t)
    const r = exact(s)
    const evs = pull(r)
    expect(evs.some((e) => e.type === 'shock')).toBe(false)
    expect(hp(r.w.byId.get(t.id)!)).toBe(HP - PISTOL)
  })

  it('one flood per cluster per tick: an explosive Shock round over four wet bodies hits each once', () => {
    const s = rig(['explosive', 'shock'])
    const pack = [body(s, 3), body(s, 3, 0.8), body(s, 3, -0.8), body(s, 3.8, 0.4)]
    for (const e of pack) wet(s.w, e)
    const r = exact(s)
    const evs = pull(r)
    const shocks = evs.filter((e) => e.type === 'shock').map((e) => (e as { targetId: number }).targetId)
    expect(shocks.sort()).toEqual(pack.map((e) => e.id).sort())
  })

  it('a bare explosive blast on a frozen body shatters; an elemental one reacts instead', () => {
    const s = rig(['explosive', 'incendiary'])
    const t = body(s, 3)
    const r = exact(s)
    const T = r.w.byId.get(t.id)!
    // Freeze it through the table's own entry point: stage the status exactly.
    T.fx = { frozen: { until: r.w.tick + 200 } }
    const evs = pull(r)
    expect(reactions(evs)).toContain('thermalCrack')
    expect(evs.some((e) => e.type === 'shatter')).toBe(false)
  })
})

describe('eject (packModSwap(i, i)) and the chips it leaves', () => {
  it('drops the entry at the feet as an arming chip, and the list closes up', () => {
    const r = exact(rig(['soak', 'shock', 'incendiary', 'heavy', 'frost']))
    const evs = run(r.w, 1, { modSwap: packModSwap(1, 1) })
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['soak', 'incendiary', 'heavy', 'frost'])
    const chip = pickups(r.w).find((e) => e.pickup!.chip)!
    expect(chip.pickup).toMatchObject({ itemId: 'shock', chip: { ejectedBy: r.p.id, ownerLeft: false } })
    expect(chip.pos).toEqual(r.p.pos)
    expect(evs.filter((e) => e.type === 'chipEject')).toHaveLength(1)
  })

  it('ejecting the not-yet-fired tail cannot skip the recharge (the free-reload exploit)', () => {
    const r = exact(rig(['soak', 'shock', 'incendiary', 'frost']))
    pull(r)
    pull(r)
    pull(r) // three of four fired; the cursor sits on frost
    expect(stack(r.p).castIndex).toBe(3)
    run(r.w, 1, { modSwap: packModSwap(3, 3) }) // eject frost: the window is now 3 long
    expect(stack(r.p).castIndex).toBe(0)
    expect(stack(r.p).rechargeUntil).toBeGreaterThan(r.w.tick)
    r.p.combat!.cooldown = 0
    const before = r.w.entities.filter((e) => e.projectile).length
    run(r.w, 1, { attack: true })
    expect(r.w.entities.filter((e) => e.projectile).length).toBe(before) // no shot
  })

  it('ejecting chips already fired keeps the SAME next chip next, and fires it', () => {
    const s = rig(['soak', 'shock', 'incendiary', 'frost'])
    body(s, 3)
    const r = exact(s)
    pull(r)
    pull(r)
    pull(r)
    run(r.w, 1, { modSwap: packModSwap(0, 0) })
    run(r.w, 1, { modSwap: packModSwap(0, 0) })
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['incendiary', 'frost'])
    expect(stack(r.p).castIndex).toBe(1)
    r.p.combat!.cooldown = 0
    run(r.w, 1, { attack: true })
    const shot = r.w.entities.filter((e) => e.projectile && !e.dead).at(-1)!
    expect(shot.projectile!.onHit?.status).toBe('frozen')
  })

  it('bad eject indices are ignored and never fall through to a swap', () => {
    const r = exact(rig(['soak', 'shock']))
    run(r.w, 1, { modSwap: packModSwap(7, 7) })
    run(r.w, 1, { modSwap: -1 })
    run(r.w, 1, { modSwap: 0.5 })
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['soak', 'shock'])
    expect(pickups(r.w)).toHaveLength(0)
  })

  it('flag OFF: packModSwap(i, i) is still the old no-op (nothing is ejected)', () => {
    const r = exact(rig(['soak', 'shock'], 'sequence'))
    run(r.w, 1, { modSwap: packModSwap(0, 0) })
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['soak', 'shock'])
    expect(pickups(r.w)).toHaveLength(0)
  })

  it('your own chip ignores you until you step off it; stepping back on re-picks it at the END', () => {
    const r = exact(rig(['soak', 'shock', 'heavy']))
    run(r.w, 1, { modSwap: packModSwap(0, 0) })
    run(r.w, 20) // standing on it: not re-picked
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['shock', 'heavy'])
    run(r.w, 12, { moveX: -1 }) // walk off
    const evs = run(r.w, 12, { moveX: 1 }) // and back over it
    expect(evs.some((e) => e.type === 'modPickup')).toBe(true)
    expect(stack(r.p).mods!.map((m) => m.id)).toEqual(['shock', 'heavy', 'soak'])
  })

  it('a full wand (slots + pocket) leaves a chip lying; so does the copy cap', () => {
    const s = rig(['soak', 'shock', 'incendiary', 'heavy', 'frost', 'pierce'])
    expect(stack(s.p).mods!.length).toBe(4 + POCKET)
    const loot = addEntity(s.w, makeEntity('pickup', 'mod.soak', s.p.pos.x, s.p.pos.y, 0.3))
    loot.pickup = { itemId: 'soak', qty: 1 }
    const r = exact(s)
    run(r.w, 5)
    expect(r.w.byId.get(loot.id)!.dead).toBeFalsy()
    // Room again, but Shock is capped at one copy per wand.
    run(r.w, 1, { modSwap: packModSwap(5, 5) }) // eject pierce
    const dupe = addEntity(r.w, makeEntity('pickup', 'mod.shock', r.p.pos.x, r.p.pos.y, 0.3))
    dupe.pickup = { itemId: 'shock', qty: 1 }
    run(r.w, 5)
    expect(dupe.dead).toBeFalsy()
    expect(r.w.byId.get(loot.id)?.dead ?? true).toBe(true) // the soak fits now (2 of 3 copies)
    expect(stack(r.p).mods!.filter((m) => m.id === 'soak')).toHaveLength(2)
  })

  it('chip conservation: 300 random streams of swaps, ejects, walks and fire never create a chip', () => {
    const count = (w: World, p: Entity): number =>
      (weaponStack(p)?.mods ?? []).reduce((n, m) => n + m.stacks, 0) + w.entities.filter((e) => e.pickup && !e.dead && e.archetype.startsWith('mod.')).length
    const base = rig(['soak', 'shock', 'incendiary', 'heavy', 'frost'])
    for (let k = 0; k < 3; k++) body(base, 4 + k, k - 1, 1000)
    const snap = JSON.stringify(serializeWorld(base.w))
    const rng = mulberry32(0xb00b)
    const seen = { chipEject: 0, modPickup: 0, chipBurst: 0 }
    for (let stream = 0; stream < 300; stream++) {
      const w = deserializeWorld(JSON.parse(snap))
      const p = w.byId.get(base.p.id)!
      let last = count(w, p)
      for (let t = 0; t < 40; t++) {
        const roll = rng.next()
        const i = Math.floor(rng.next() * 7)
        const j = Math.floor(rng.next() * 7)
        const c: Partial<InputCmd> = {
          moveX: Math.round(rng.next() * 2 - 1),
          moveY: Math.round(rng.next() * 2 - 1),
          attack: rng.next() < 0.5,
          aimX: rng.next() * 2 - 1,
          aimY: rng.next() * 2 - 1,
        }
        if (roll < 0.25) c.modSwap = packModSwap(i, i)
        else if (roll < 0.5) c.modSwap = packModSwap(i, j)
        tickWorld(w, cmd(c))
        for (const ev of w.events) if (ev.type in seen) seen[ev.type as keyof typeof seen]++
        const now = count(w, p)
        expect(now).toBeLessThanOrEqual(last)
        last = now
      }
    }
    // The property is only worth something if the streams really moved chips.
    expect(seen.chipEject).toBeGreaterThan(100)
    expect(seen.modPickup).toBeGreaterThan(10)
  })
})

describe('cracking an ejected chip', () => {
  /** A rig with an ejected chip of `mod` staged `dx` tiles east, armed or not. */
  const chipRig = (mod: string, armed: boolean, ejected = true): { r: Rig; chip: Entity; near: Entity[]; farBody: Entity } => {
    const s = rig(['heavy'])
    const chip = addEntity(s.w, makeEntity('pickup', `mod.${mod}`, s.lane.x + 0.5 + 4, s.lane.y + 0.5, 0.3))
    chip.pickup = { itemId: mod, qty: 1, ...(ejected ? { chip: { ejectedBy: s.p.id, armedAt: armed ? 0 : 10_000, ownerLeft: true } } : {}) }
    const near = [body(s, 4, 1.2), body(s, 4.8, 0.9)] // one wet-able cluster (0.85 apart)
    const farBody = body(s, 4, -2.4) // 2.4 away: beyond the 2-tile burst
    return { r: exact(s), chip, near, farBody }
  }

  it('an armed Soak chip bursts: every body within 2 tiles is wet, the chip is gone', () => {
    const { r, chip, near, farBody } = chipRig('soak', true)
    const evs = pull(r)
    expect(r.w.byId.get(chip.id)?.dead ?? true).toBe(true)
    const burst = evs.find((e) => e.type === 'chipBurst')
    expect(burst).toMatchObject({ modId: 'soak', bodies: 2, byId: r.p.id })
    for (const e of near) expect(hasStatus(r.w.byId.get(e.id)!, 'wet')).toBe(true)
    expect(hasStatus(r.w.byId.get(farBody.id)!, 'wet')).toBe(false)
  })

  it('a Shock chip cracked on a wet crowd chains once through it (no n-squared flood)', () => {
    const { r, near } = chipRig('shock', true)
    for (const e of near) wet(r.w, r.w.byId.get(e.id)!)
    const evs = pull(r)
    expect(reactions(evs)).toEqual(['chain'])
    for (const e of near) expect(hp(r.w.byId.get(e.id)!)).toBe(HP - ELEC)
  })

  it('an unarmed chip, a floor-loot chip, and a stat chip never crack', () => {
    for (const [mod, armed, ejected] of [['soak', false, true], ['soak', true, false], ['heavy', true, true]] as const) {
      const { r, chip } = chipRig(mod, armed, ejected)
      const evs = pull(r)
      expect(evs.some((e) => e.type === 'chipBurst')).toBe(false)
      expect(r.w.byId.get(chip.id)!.dead).toBeFalsy()
    }
  })

  it('a round fired while standing on your own armed chip passes over it', () => {
    const s = rig(['heavy'])
    const chip = addEntity(s.w, makeEntity('pickup', 'mod.soak', s.p.pos.x + 0.3, s.p.pos.y, 0.3))
    chip.pickup = { itemId: 'soak', qty: 1, chip: { ejectedBy: s.p.id, armedAt: 0, ownerLeft: true } }
    const r = exact(s)
    const evs = pull(r)
    expect(evs.some((e) => e.type === 'chipBurst')).toBe(false)
  })

  it('a chip arms exactly CHIP_ARM_TICKS after the eject', () => {
    const r = exact(rig(['soak', 'heavy']))
    run(r.w, 1, { modSwap: packModSwap(0, 0) })
    const chip = pickups(r.w).find((e) => e.pickup!.chip)!
    expect(chip.pickup!.chip!.armedAt).toBe(r.w.tick - 1 + CHIP_ARM_TICKS)
  })
})

describe('the boss hide (reactive runs only)', () => {
  const bossWorld = (casting: ModCasting | undefined): { w: World; boss: Entity } => {
    const w = createWorld(1, 1)
    if (casting) w.modCasting = casting
    const lane = openLane(w)
    const boss = spawnNpc(w, 'boss', lane.x + 6.5, lane.y + 0.5)
    boss.ai = undefined
    return { w: deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w)))), boss }
  }

  it('keeps Mireclaw soaked above half health, and dries it off below', () => {
    const { w, boss } = bossWorld('reactive')
    const b = w.byId.get(boss.id)!
    for (let t = 0; t < 200; t++) {
      tickWorld(w, new Map())
      expect(hasStatus(b, 'wet')).toBe(true)
    }
    b.health!.hp = Math.floor(b.health!.max * 0.5)
    tickWorld(w, new Map())
    // The last re-soak lasts at most `every + 1` ticks, then nothing renews it.
    for (let t = 0; t < 62; t++) tickWorld(w, new Map())
    expect(hasStatus(b, 'wet')).toBe(false)
  })

  it('brings its lightning weakness with it, in reactive runs only', () => {
    expect(bossWorld('reactive').boss.resist?.electrified).toBe(1.6)
    expect(bossWorld(undefined).boss.resist?.electrified).toBeUndefined()
    expect(bossWorld('sequence').boss.resist?.electrified).toBeUndefined()
  })

  it('a Shock round into the soaked boss chains for 1.6x; a Fire round fizzles off it', () => {
    const s = rig(['shock', 'incendiary'])
    const boss = spawnNpc(s.w, 'boss', s.lane.x + 3.5, s.lane.y + 0.5)
    boss.ai = undefined
    const r = exact(s)
    const b = r.w.byId.get(boss.id)!
    run(r.w, 1) // the hide soaks it
    const hp0 = hp(b)
    const zap = pull(r)
    expect(reactions(zap)).toEqual(['chain'])
    expect(hp0 - hp(b)).toBe(Math.round(PISTOL * 0.75) + Math.round(ELEC * 1.6))
    expect(reactions(pull(r))).toEqual(['fizzle'])
    expect(hasStatus(b, 'burning')).toBe(false)
  })

  it('never touches a boss outside a reactive run', () => {
    for (const casting of [undefined, 'sequence'] as const) {
      const { w, boss } = bossWorld(casting)
      for (let t = 0; t < 130; t++) tickWorld(w, new Map())
      expect(hasStatus(w.byId.get(boss.id)!, 'wet')).toBe(false)
    }
  })
})

describe('the Soak chip stays out of every non-reactive run', () => {
  it('never appears in the draft hand or the floor-drop draw unless the run is reactive', () => {
    for (let seed = 1; seed <= 40; seed++) expect(floorDraftOffer(seed, 2, 999)).not.toContain('soak')
    const plain = mulberry32(7)
    const reactive = mulberry32(7)
    const plainDraws = new Set(Array.from({ length: 2000 }, () => weightedModId(plain)))
    const reactiveDraws = new Set(Array.from({ length: 2000 }, () => weightedModId(reactive, true)))
    expect(plainDraws.has('soak')).toBe(false)
    expect(reactiveDraws.has('soak')).toBe(true)
  })
})

describe('determinism', () => {
  it('a reactive run split across a save is byte-identical to one continuous run', () => {
    const s = rig(['soak', 'shock', 'incendiary', 'frost', 'heavy'])
    body(s, 3)
    body(s, 3, 1.2)
    const script = (t: number): Partial<InputCmd> =>
      t === 5 ? { modSwap: packModSwap(4, 4) } : t === 40 ? { modSwap: packModSwap(0, 1) } : { attack: t % 3 !== 0, moveY: t > 60 ? 1 : 0 }
    const a = exact(s)
    for (let t = 0; t < 120; t++) tickWorld(a.w, cmd(script(t)))
    const b = exact(s)
    for (let t = 0; t < 55; t++) tickWorld(b.w, cmd(script(t)))
    const c = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(b.w))))
    for (let t = 55; t < 120; t++) tickWorld(c, cmd(script(t)))
    expect(c.modCasting).toBe('reactive')
    expectWorldEqual(a.w, c)
  })
})
