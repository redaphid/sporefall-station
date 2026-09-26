// Essence bubbles (prototype C): every rule driven through the REAL systems
// (tickWorld / combatSystem / projectileSystem / interactionSystem) from exact
// world state. Each test states the rule it pins and tries to break it.

import { describe, expect, it } from 'vitest'
import { MODS } from '../data/mods'
import { BUBBLE_TTL_TICKS, lensCharges, MOD_FAMILY } from '../data/essences'
import { WEAPONS } from '../data/items'
import type { Entity, WeaponMod } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { applyScenario } from '../scenarios'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { arm, expectWorldEqual } from '../testkit'
import { packStill, plantBubble, STILL_NEXT, STILL_PLANT, unpackStill } from './essence'
import { weaponStack } from './inventory'
import { spawnProjectile } from './combat'
import { freeze, shock, wet } from './interactions'
import { sequenceShape } from './modSequence'
import { nextFloor } from './missions'
import { isFrozen } from './statusFx'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

/** A row of `n` open cells on seed 1 floor 1, so bodies can be laid out on a line. */
const openRow = (w: World, n: number): { x: number; y: number } => {
  for (let y = 10; y < w.level.h - 10; y++)
    for (let x = 5; x < w.level.w - n - 5; x++) {
      let ok = true
      for (let i = 0; i < n && ok; i++) for (let dy = -1; dy <= 1 && ok; dy++) if (isSolidTile(w.level, x + i, y + dy)) ok = false
      if (ok) return { x, y }
    }
  throw new Error('no open row')
}

interface Rig {
  w: World
  p: Entity
  x: number
  y: number
}

/** A world with essence bubbles on (unless `bubbles` is false), one player at the
 * west end of an open row facing east, holding `weapon` racked with `mods`. */
const rig = (weapon: string, mods: WeaponMod[], bubbles = true): Rig => {
  const w = createWorld(1, 1)
  w.modCasting = 'sequence'
  if (bubbles) w.essences = 'bubbles'
  const { x, y } = openRow(w, 14)
  const p = spawnPlayer(w, 0, x + 0.5, y + 0.5)
  p.health!.iframes = 0
  p.loadout!.inventory = []
  arm(p, weapon).mods = mods.map((e) => ({ ...e }))
  p.facing = 0
  return { w, p, x, y }
}

/** A still NPC (no brain) at a cell centre. */
const dummy = (w: World, archetype: string, x: number, y: number): Entity => {
  const e = spawnNpc(w, archetype, x, y)
  e.ai = undefined
  e.intent = { x: 0, y: 0 }
  return e
}

const tick = (w: World, cmd: Partial<InputCmd> = {}, n = 1): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput(), ...cmd }]]))
}

const bubbles = (w: World): Entity[] => w.entities.filter((e) => e.bubble && !e.dead)
const rack = (p: Entity): string[] => (weaponStack(p)!.mods ?? []).map((e) => e.id)
const vent = (index: number): Partial<InputCmd> => ({ still: packStill(STILL_PLANT, index) })

describe('data', () => {
  it('every mod has exactly one hue family, and no family names a mod that does not exist', () => {
    expect(Object.keys(MOD_FAMILY).sort()).toEqual(Object.keys(MODS).sort())
  })
  it('lens charges are 3 + 3 per stack, capped at 9, and never below 6 for a real mod', () => {
    expect([1, 2, 3, 5, 99].map(lensCharges)).toEqual([6, 9, 9, 9, 9])
    expect(lensCharges(0)).toBe(6) // a junk stack count is treated as one stack
  })
  it('still packs and unpacks', () => {
    for (const [op, i] of [[1, 0], [1, 7], [2, 255]]) expect(unpackStill(packStill(op, i))).toEqual({ op, index: i })
  })
})

describe('vent', () => {
  it('venting a LIVE entry plants it at your feet and costs the wrap recharge', () => {
    const { w, p } = rig('pistol', [m('heavy'), m('frost'), m('pierce'), m('shock'), m('split')])
    weaponStack(p)!.castIndex = 2
    tick(w, vent(3))
    expect(rack(p)).toEqual(['heavy', 'frost', 'pierce', 'split'])
    const [b] = bubbles(w)
    expect(b.archetype).toBe('mod.shock')
    expect(b.pos).toEqual(p.pos)
    expect(b.bubble!.charges).toBe(6)
    const stack = weaponStack(p)!
    expect(stack.castIndex).toBe(0)
    expect(stack.rechargeUntil).toBe(0 + sequenceShape(WEAPONS.pistol).rechargeOnWrap)
    // And the recharge is real: holding fire through it produces no round.
    const before = w.entities.length
    tick(w, { attack: true }, 19)
    expect(w.entities.filter((e) => e.projectile).length).toBe(0)
    expect(w.entities.length).toBe(before)
    tick(w, { attack: true }, 2)
    expect(w.entities.some((e) => e.projectile)).toBe(true)
  })

  it('venting a STOWED entry is free: no recharge, castIndex kept', () => {
    const { w, p } = rig('pistol', [m('heavy'), m('frost'), m('pierce'), m('shock'), m('split')])
    weaponStack(p)!.castIndex = 2
    tick(w, vent(4))
    const stack = weaponStack(p)!
    expect(rack(p)).toEqual(['heavy', 'frost', 'pierce', 'shock'])
    expect(stack.castIndex).toBe(2)
    expect(stack.rechargeUntil).toBeUndefined()
  })

  it('a vent during a running recharge never shortens it', () => {
    const { w, p } = rig('shotgun', [m('frost'), m('shock')])
    weaponStack(p)!.rechargeUntil = 500
    tick(w, vent(0))
    expect(weaponStack(p)!.rechargeUntil).toBe(500)
  })

  it('invalid requests change nothing: out of range, unknown op, empty rack, flag off, sequencing off', () => {
    const cases: [Rig, Partial<InputCmd>][] = [
      [rig('pistol', [m('shock')]), vent(1)],
      [rig('pistol', [m('shock')]), vent(254)],
      [rig('pistol', [m('shock')]), { still: packStill(2, 0) }],
      [rig('pistol', [m('shock')]), { still: -1 }],
      [rig('pistol', [m('shock')]), { still: 1.5 }],
      [rig('pistol', []), vent(0)],
      [rig('pistol', [m('shock')], false), vent(0)],
    ]
    const noSeq = rig('pistol', [m('shock')])
    noSeq.w.modCasting = undefined
    cases.push([noSeq, vent(0)])
    for (const [r, cmd] of cases) {
      const before = JSON.stringify(weaponStack(r.p)!.mods)
      tick(r.w, cmd)
      expect(bubbles(r.w)).toEqual([])
      expect(JSON.stringify(weaponStack(r.p)!.mods)).toBe(before)
    }
  })

  it('STILL_NEXT vents the chamber that fires next (the V key), live window only', () => {
    const { w, p } = rig('pistol', [m('heavy'), m('frost'), m('pierce'), m('shock'), m('split')])
    weaponStack(p)!.castIndex = 1
    tick(w, vent(STILL_NEXT))
    expect(bubbles(w)[0].archetype).toBe('mod.frost')
    expect(rack(p)).toEqual(['heavy', 'pierce', 'shock', 'split'])
    // A stale index past the window falls back to the first chamber.
    weaponStack(p)!.castIndex = 9
    weaponStack(p)!.rechargeUntil = undefined
    tick(w, vent(STILL_NEXT))
    expect(bubbles(w).map((b) => b.archetype)).toEqual(['mod.frost', 'mod.heavy'])
    // An empty rack: nothing to vent.
    const empty = rig('pistol', [])
    tick(empty.w, vent(STILL_NEXT))
    expect(bubbles(empty.w)).toEqual([])
  })

  it('a junk entry (unknown id) is not ventable and stays put', () => {
    const { w, p } = rig('pistol', [m('notAMod'), m('shock')])
    tick(w, vent(0))
    expect(bubbles(w)).toEqual([])
    expect(rack(p)).toEqual(['notAMod', 'shock'])
  })

  it('a downed diver cannot vent', () => {
    const { w, p } = rig('pistol', [m('shock')])
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    tick(w, vent(0))
    expect(bubbles(w)).toEqual([])
  })

  it('a third plant pops the oldest; two stay', () => {
    const { w } = rig('pistol', [m('shock'), m('frost'), m('incendiary')])
    tick(w, vent(0))
    tick(w, vent(0))
    expect(bubbles(w).map((b) => b.archetype)).toEqual(['mod.shock', 'mod.frost'])
    tick(w, vent(0))
    expect(bubbles(w).map((b) => b.archetype)).toEqual(['mod.frost', 'mod.incendiary'])
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'bubblePop', reason: 'capped', modId: 'shock' }))
  })

  it("the cap is per diver: a teammate's bubbles are not popped by mine", () => {
    const { w, p, x, y } = rig('pistol', [m('shock'), m('frost'), m('incendiary')])
    const mate = spawnPlayer(w, 1, x + 3.5, y + 0.5)
    plantBubble(w, mate, m('heavy'), x + 3.5, y + 0.5)
    plantBubble(w, mate, m('pierce'), x + 4.5, y + 0.5)
    for (let i = 0; i < 3; i++) tick(w, vent(0))
    expect(bubbles(w).filter((b) => b.bubble!.ventedBy === mate.id)).toHaveLength(2)
    expect(bubbles(w).filter((b) => b.bubble!.ventedBy === p.id)).toHaveLength(2)
  })
})

describe('expiry', () => {
  it('a planted bubble pops exactly BUBBLE_TTL_TICKS after it was planted', () => {
    const { w } = rig('pistol', [m('shock')])
    tick(w, { ...emptyInput() }, 5)
    tick(w, vent(0)) // planted during tick 5
    const b = bubbles(w)[0]
    expect(b.bubble!.expiresTick).toBe(5 + BUBBLE_TTL_TICKS)
    tick(w, {}, BUBBLE_TTL_TICKS - 1) // through tick 5 + 599
    expect(b.dead).toBeFalsy()
    tick(w)
    expect(w.byId.has(b.id)).toBe(false)
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'bubblePop', reason: 'expired', entityId: b.id }))
  })

  it('bubbles never cross floors', () => {
    const { w } = rig('pistol', [m('shock')])
    tick(w, vent(0))
    nextFloor(w)
    expect(bubbles(w)).toEqual([])
  })
})

describe('catch', () => {
  it('interact next to a bubble puts it at the END of the rack and does not reset castIndex or the recharge', () => {
    const { w, p } = rig('pistol', [m('heavy'), m('frost'), m('pierce'), m('shock')])
    tick(w, vent(0))
    const stack = weaponStack(p)!
    stack.castIndex = 2
    const recharge = stack.rechargeUntil
    tick(w, { interact: true })
    expect(bubbles(w)).toEqual([])
    expect(rack(p)).toEqual(['frost', 'pierce', 'shock', 'heavy'])
    expect(stack.castIndex).toBe(2)
    expect(stack.rechargeUntil).toBe(recharge)
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'bubbleCatch', modId: 'heavy', byId: p.id }))
  })

  it('a duplicate essence comes back as its own entry, never merged into a maxed one', () => {
    const { w, p } = rig('pistol', [m('shock'), m('frost')])
    plantBubble(w, p, m('shock'), p.pos.x, p.pos.y)
    tick(w, { interact: true })
    expect(rack(p)).toEqual(['shock', 'frost', 'shock'])
  })

  it('walking through a planted bubble neither catches nor bursts it (players never set off mines)', () => {
    const { w, p, x, y } = rig('pistol', [m('shock')])
    const b = plantBubble(w, p, m('shock'), x + 3.5, y + 0.5)
    tick(w, { moveX: 1 }, 45) // walks straight through it
    expect(p.pos.x).toBeGreaterThan(x + 4.5)
    expect(b.dead).toBeFalsy()
    expect(rack(p)).toEqual(['shock'])
    expect(p.fx?.electrified).toBeUndefined()
  })

  it('out of reach, interact does nothing', () => {
    const { w, p, x, y } = rig('pistol', [m('shock')])
    plantBubble(w, p, m('frost'), x + 4.5, y + 0.5)
    tick(w, { interact: true })
    expect(bubbles(w)).toHaveLength(1)
  })

  it('a teammate can catch my bubble (stealing is possible, and loud)', () => {
    const { w, p, x, y } = rig('pistol', [m('shock')])
    const mate = spawnPlayer(w, 1, x + 3.5, y + 0.5)
    mate.loadout!.inventory = []
    arm(mate, 'pistol')
    plantBubble(w, p, m('frost'), x + 3.5, y + 0.5)
    tickWorld(w, new Map([[1, { ...emptyInput(), interact: true }]]))
    expect(rack(mate)).toEqual(['frost'])
  })

  it('EXPLOIT GUARD: plant, spend, catch, re-plant does not refill the lens', () => {
    const { w, p, x, y } = rig('pistol', [m('frost'), m('shock')])
    // Plant the shock lens at the muzzle and fire the frost cast through it twice.
    tick(w, vent(1))
    const b = bubbles(w)[0]
    dummy(w, 'robot', x + 8.5, y + 0.5).health!.hp = 9999
    tick(w, { attack: true }, 40)
    const left = b.bubble!.charges
    expect(left).toBeLessThan(6)
    expect(left).toBeGreaterThan(0)
    tick(w, { interact: true })
    expect(weaponStack(p)!.mods!.at(-1)).toEqual({ id: 'shock', stacks: 1, charges: left })
    tick(w, vent(1))
    expect(bubbles(w)[0].bubble!.charges).toBe(left)
  })
})

describe('lens', () => {
  /** Fire one pull of the rack east through whatever is planted; returns the rounds. */
  const pullOnce = (w: World, p: Entity): Entity[] => {
    const before = new Set(w.entities.map((e) => e.id))
    p.combat!.cooldown = 0
    tick(w, { attack: true })
    return w.entities.filter((e) => !before.has(e.id) && e.projectile)
  }

  it('a round flying through a bubble picks up its essence, and the bubble loses one charge', () => {
    const { w, p, x, y } = rig('pistol', [m('frost')])
    const b = plantBubble(w, p, m('shock'), x + 2.5, y + 0.5)
    const [round] = pullOnce(w, p)
    tick(w, {}, 6)
    expect(round.projectile!.rider).toEqual({ id: 'shock', stacks: 1 })
    expect(round.projectile!.mods?.map((e) => e.id)).toEqual(['frost', 'shock'])
    expect(b.bubble!.charges).toBe(5)
  })

  it('one rider per round: two bubbles in a line give the first only, and only the first spends', () => {
    const { w, p, x, y } = rig('pistol', [m('heavy')])
    const a = plantBubble(w, p, m('shock'), x + 2.5, y + 0.5)
    const c = plantBubble(w, p, m('frost'), x + 4.5, y + 0.5)
    const [round] = pullOnce(w, p)
    tick(w, {}, 12)
    expect(round.projectile!.rider!.id).toBe('shock')
    expect(a.bubble!.charges).toBe(5)
    expect(c.bubble!.charges).toBe(6)
  })

  it('a round that already carries the element gains nothing and spends nothing', () => {
    const { w, p, x, y } = rig('pistol', [m('shock')])
    const b = plantBubble(w, p, m('shock'), x + 2.5, y + 0.5)
    const [round] = pullOnce(w, p)
    tick(w, {}, 6)
    expect(round.projectile!.rider).toBeUndefined()
    expect(b.bubble!.charges).toBe(6)
  })

  it('every pellet counts: a shotgun pull drains a lens, the bubble pops at zero and the next pellet gets nothing', () => {
    const { w, p, x, y } = rig('shotgun', [m('frost'), m('bulk'), m('incendiary')]) // 5 + 2 pellets
    const b = plantBubble(w, p, m('shock'), x + 0.5, y + 0.5) // at the muzzle: every pellet crosses it
    const rounds = pullOnce(w, p)
    tick(w)
    expect(rounds.length).toBe(7)
    const riders = rounds.filter((r) => r.projectile!.rider)
    expect(riders).toHaveLength(6)
    expect(b.dead).toBe(true)
  })

  it('a modifier rider applies as if it were in the cast (pierce lets the round through a body)', () => {
    const { w, p, x, y } = rig('pistol', [m('frost')])
    plantBubble(w, p, m('pierce'), x + 1.5, y + 0.5)
    const front = dummy(w, 'thug', x + 4.5, y + 0.5)
    const back = dummy(w, 'thug', x + 6.5, y + 0.5)
    front.health!.hp = back.health!.hp = 999
    const [round] = pullOnce(w, p)
    tick(w, {}, 20)
    expect(round.projectile!.rider!.id).toBe('pierce')
    expect(isFrozen(front)).toBe(true)
    expect(isFrozen(back)).toBe(true)
  })

  it("enemy rounds never pick up a rider (a bubble is the players' tool)", () => {
    const { w, p, x, y } = rig('pistol', [m('frost')])
    const b = plantBubble(w, p, m('shock'), x + 3.5, y + 0.5)
    const gunner = dummy(w, 'thug', x + 6.5, y + 0.5)
    gunner.health!.hp = 999
    // Hand-launch a round owned by the NPC, flying west through the bubble.
    gunner.facing = Math.PI
    spawnProjectile(w, gunner, 5, 14, 10)
    tick(w, {}, 10)
    expect(b.bubble!.charges).toBe(6)
  })
})

describe('mines', () => {
  it('an enemy that walks into a Storm bubble bursts it: everything within 1.5 is zapped', () => {
    const { w, p, x, y } = rig('pistol', [m('heavy')])
    const b = plantBubble(w, p, m('shock'), x + 5.5, y + 0.5)
    const walker = spawnNpc(w, 'thug', x + 8.5, y + 0.5)
    const bystander = dummy(w, 'thug', x + 5.5, y + 1.5)
    const far = dummy(w, 'thug', x + 9.5, y + 1.5)
    walker.ai = undefined
    walker.intent = { x: -1, y: 0 }
    walker.speed = 3
    for (let i = 0; i < 90 && !b.dead; i++) {
      walker.intent = { x: -1, y: 0 }
      tick(w)
    }
    expect(b.dead).toBe(true)
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'bubblePop', reason: 'burst', modId: 'shock' }))
    expect(walker.fx?.electrified).toBeDefined()
    expect(bystander.fx?.electrified).toBeDefined()
    expect(far.fx?.electrified).toBeUndefined()
  })

  it('a Cold mine freezes, a Flame mine lights the cells around it', () => {
    const { w, p, x, y } = rig('pistol', [])
    const cold = plantBubble(w, p, m('frost'), x + 4.5, y + 0.5)
    const hot = plantBubble(w, p, m('incendiary'), x + 9.5, y + 0.5)
    const a = dummy(w, 'thug', x + 4.5, y + 0.5)
    const c = dummy(w, 'thug', x + 9.5, y + 0.5)
    tick(w)
    expect(cold.dead && hot.dead).toBe(true)
    expect(isFrozen(a)).toBe(true)
    expect(isFrozen(c)).toBe(false)
    const fires = w.entities.filter((e) => e.fire && !e.dead)
    expect(fires.length).toBeGreaterThanOrEqual(5)
    for (const f of fires) expect(Math.abs(f.pos.x - (x + 9.5)) + Math.abs(f.pos.y - (y + 0.5))).toBeLessThanOrEqual(2)
  })

  it('a non-element bubble is a lens only: an enemy walks straight through it', () => {
    const { w, p, x, y } = rig('pistol', [])
    const b = plantBubble(w, p, m('pierce'), x + 4.5, y + 0.5)
    dummy(w, 'thug', x + 4.5, y + 0.5)
    tick(w, {}, 3)
    expect(b.dead).toBeFalsy()
  })

  it('props and corpses do not set off a mine', () => {
    const { w, p, x, y } = rig('pistol', [])
    const b = plantBubble(w, p, m('shock'), x + 4.5, y + 0.5)
    const corpse = dummy(w, 'thug', x + 4.5, y + 0.5)
    corpse.dead = true
    tick(w, {}, 3)
    expect(b.dead).toBeFalsy()
  })
})

describe('Conductor and weak-to-lightning (shock under the flag)', () => {
  /** Three bodies 1.2 tiles apart (inside the 1.6 arc reach). */
  const chain = (w: World, x: number, y: number, archetype = 'robot'): Entity[] =>
    [0, 1.2, 2.4].map((dx) => {
      const e = dummy(w, archetype, x + 4.5 + dx, y + 0.5)
      e.health!.hp = e.health!.max = 500
      return e
    })

  it('a frozen pack: one zap shatters every body in the chain, x SHATTER on the zap', () => {
    const { w, x, y } = rig('pistol', [])
    const pack = chain(w, x, y)
    for (const e of pack) freeze(w, e)
    shock(w, pack[0])
    expect(pack.map((e) => e.health!.hp)).toEqual([400, 400, 400])
    expect(pack.every((e) => !isFrozen(e))).toBe(true)
    expect(w.events.filter((e) => e.type === 'conductor')).toHaveLength(3)
  })

  it('a dry, unfrozen pack: the zap stuns one body and stops', () => {
    const { w, x, y } = rig('pistol', [])
    const pack = chain(w, x, y)
    shock(w, pack[0])
    expect(pack.map((e) => e.health!.hp)).toEqual([500, 500, 500])
    expect(pack.map((e) => !!e.fx?.electrified)).toEqual([true, false, false])
  })

  it('a frozen body across a DRY gap is not reached (the arc needs a conductive path)', () => {
    const { w, x, y } = rig('pistol', [])
    const [a, b, c] = chain(w, x, y)
    freeze(w, a)
    freeze(w, c)
    shock(w, a)
    expect([a, b, c].map((e) => e.health!.hp)).toEqual([400, 500, 500])
  })

  it('weak to lightning is real: resist.electrified 2 doubles it, 0 is immune but still conducts', () => {
    const { w, x, y } = rig('pistol', [])
    const [a, b, c] = chain(w, x, y)
    a.resist = { electrified: 2 }
    b.resist = { electrified: 0 }
    for (const e of [a, b, c]) wet(w, e)
    shock(w, a)
    expect([a, b, c].map((e) => e.health!.hp)).toEqual([460, 500, 480])
  })

  it('a zap kills through the shatter: the body gibs', () => {
    const { w, x, y } = rig('pistol', [])
    const e = dummy(w, 'thug', x + 4.5, y + 0.5)
    freeze(w, e)
    shock(w, e)
    expect(e.dead).toBe(true)
    expect(e.shattered).toBe(true)
  })

  it('a frozen PLAYER in the arc has the ice cracked, not shattered', () => {
    const { w, p } = rig('pistol', [])
    const hp = p.health!.hp
    freeze(w, p)
    shock(w, p)
    expect(hp - p.health!.hp).toBe(20)
    expect(isFrozen(p)).toBe(false)
  })

  it('FLAG OFF: shock is exactly as on main (frozen does not conduct, resist is ignored)', () => {
    const { w, x, y } = rig('pistol', [], false)
    const [a, b] = chain(w, x, y)
    a.resist = { electrified: 2 }
    freeze(w, a)
    freeze(w, b)
    shock(w, a)
    expect([a.health!.hp, b.health!.hp]).toEqual([500, 500])
    wet(w, a)
    a.fx!.electrified.until = 0
    a.lockout = undefined
    shock(w, a)
    expect(a.health!.hp).toBe(480) // resist 2 ignored with the flag off
  })

  it('end to end: a frost round through a Storm lens freezes, then zaps, then shatters the target (Conductor on one round)', () => {
    const { w, p, x, y } = rig('pistol', [m('frost')])
    plantBubble(w, p, m('shock'), x + 1.5, y + 0.5)
    const boss = dummy(w, 'boss', x + 6.5, y + 0.5)
    boss.resist = { ...boss.resist, electrified: 2 }
    const hp = boss.health!.hp
    tick(w, { attack: true })
    tick(w, {}, 20)
    const pistolHit = Math.round(14 * 0.75)
    expect(hp - boss.health!.hp).toBe(pistolHit + 20 * 2 * 5)
  })

  it('end to end: a storm round into a FROZEN pack arcs through the whole pack, though its impact broke the first ice', () => {
    const { w, x, y } = rig('pistol', [m('shock')])
    const pack = chain(w, x, y)
    for (const e of pack) freeze(w, e)
    tick(w, { attack: true })
    tick(w, {}, 12)
    const impact = Math.round(14 * 5 * 0.4) // pistol x SHATTER on the robot's 0.4 physical
    expect(pack.map((e) => 500 - e.health!.hp)).toEqual([impact + 20, 100, 100])
  })

  it('the same storm round into a frozen body with nothing frozen or wet beside it: no arc beyond it', () => {
    const { w, x, y } = rig('pistol', [m('shock')])
    const [a, b] = chain(w, x, y)
    freeze(w, a)
    tick(w, { attack: true })
    tick(w, {}, 12)
    expect(500 - b.health!.hp).toBe(0)
    expect(b.fx?.electrified).toBeUndefined()
  })

  it('the same round with no lens: freeze only (the unprepared case)', () => {
    const { w, x, y } = rig('pistol', [m('frost')])
    const boss = dummy(w, 'boss', x + 6.5, y + 0.5)
    boss.resist = { ...boss.resist, electrified: 2 }
    const hp = boss.health!.hp
    tick(w, { attack: true })
    tick(w, {}, 20)
    expect(hp - boss.health!.hp).toBe(Math.round(14 * 0.75))
    expect(isFrozen(boss)).toBe(true)
  })
})

describe('determinism and flag isolation', () => {
  /** The showcase, scripted: vent, fire through the lens, strafe, catch. */
  const script = (t: number): Partial<InputCmd> => {
    if (t === 3) return { still: packStill(STILL_PLANT, 2) }
    if (t === 200) return { interact: true }
    return { attack: t % 3 !== 0, moveY: Math.sin(t * 0.05) * 0.5, aimX: 1, aimY: Math.sin(t * 0.03) * 0.2 }
  }
  const showcase = (seed: number): World => {
    const w = createWorld(seed, 1)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    applyScenario(w, 'lens')
    return w
  }

  it('the lens scenario: same seed + same inputs → byte-identical world, split or continuous', () => {
    const a = showcase(7)
    const b = showcase(7)
    for (let t = 0; t < 300; t++) {
      tick(a, script(t))
      tick(b, script(t))
    }
    expectWorldEqual(a, b)
    // Split across a serialize round trip at tick 120.
    const c = showcase(7)
    for (let t = 0; t < 120; t++) tick(c, script(t))
    const d = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(c))))
    for (let t = 120; t < 300; t++) tick(d, script(t))
    expect(serializeWorld(d)).toEqual(serializeWorld(a))
    // And the script really exercised the mechanic.
    expect(a.essences).toBe('bubbles')
  })

  it('the lens scenario really plays the loop: the opening pull kills robots by Conductor', () => {
    const w = showcase(7)
    const robots = () => w.entities.filter((e) => e.archetype === 'robot' && !e.dead).length
    expect(robots()).toBe(6)
    const shattered: number[] = []
    for (let t = 0; t < 20; t++) {
      tick(w, { attack: true, aimX: 1, aimY: 0 })
      for (const ev of w.events) if (ev.type === 'conductor') shattered.push(ev.targetId)
    }
    expect(shattered.length).toBeGreaterThanOrEqual(1)
    expect(robots()).toBeLessThan(6)
  })

  it('serialization: the run rule round-trips, and a world without it writes no key', () => {
    const on = rig('pistol', [m('shock')])
    tick(on.w, vent(0))
    const j = serializeWorld(on.w)
    expect(j.essences).toBe('bubbles')
    const back = deserializeWorld(JSON.parse(JSON.stringify(j)))
    expect(back.essences).toBe('bubbles')
    expect(bubbles(back)[0].bubble).toEqual(bubbles(on.w)[0].bubble)
    const off = rig('pistol', [m('shock')], false)
    expect('essences' in serializeWorld(off.w)).toBe(false)
  })

  it('flag off, a vent in the input is inert: the world matches one that never saw it', () => {
    const a = rig('pistol', [m('frost'), m('shock')], false)
    const b = rig('pistol', [m('frost'), m('shock')], false)
    for (let t = 0; t < 120; t++) {
      const base = { attack: t % 2 === 0 }
      tick(a.w, t % 7 === 0 ? { ...base, ...vent(t % 3) } : base)
      tick(b.w, base)
    }
    expectWorldEqual(a.w, b.w)
    expect(JSON.stringify(serializeWorld(a.w))).not.toContain('bubble')
  })
})
