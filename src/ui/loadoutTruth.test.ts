// #88 contract: every number and badge on the loadout panel equals what the
// real fire path does. For every weapon and a spread of mod lists (singles,
// every ordered pair, payload+payload, three-mod wands), the test builds the
// panel, fires the real `fireWeapon` from the same state, reads the result off
// the world (projectiles, hit events, cooldown) and compares. Each list is
// walked pull by pull through a whole cycle, so multi-cast pulls, pellet splits
// and the wrap recharge are all checked.
//
// It also holds the chip's live/penalty call to the fired outcome: a "penalty"
// mod may only make fired numbers worse, and a "live" mod must improve one or
// change a behaviour.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { fireWeapon } from '../game/systems/combat'
import { weaponStack } from '../game/systems/inventory'
import { modVerdict } from '../game/systems/modEffect'
import { cycleCasts, sequenceShape } from '../game/systems/modSequence'
import { arm } from '../game/testkit'
import { SIM_RATE } from '../game/types'
import { addEntity, createWorld, type World } from '../game/world'
import { buildLoadout, type LoadoutModel } from './loadoutModel'

const MOD_IDS = Object.keys(MODS)
const WEAPON_IDS = Object.keys(WEAPONS).filter((id) => id !== 'fists')
const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })
const round = (n: number, dp = 0): number => Math.round(n * 10 ** dp) / 10 ** dp

/** Distinct values in first-seen order, printed the way the panel prints them. */
const text = (values: number[], fmt: (n: number) => string): string =>
  [...new Set(values.map((n) => round(n, 3)))].map(fmt).join('/')

/** A player facing east at a 1000-hp thug one tile away, holding `weaponId`. */
const rig = (weaponId: string, mods: WeaponMod[]): World => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20.5, 20.5)
  p.loadout!.inventory = []
  arm(p, weaponId).mods = mods.map((x) => ({ ...x }))
  p.facing = 0
  const t = addEntity(w, makeEntity('npc', 'thug', 21.5, 20.5))
  t.health = { hp: 1000, max: 1000, iframes: 0 }
  t.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 } // as populate.ts gives a real NPC
  return deserializeWorld(serializeWorld(w))
}

interface Fired {
  rate: number
  damage: number[]
  knockback?: number
  pellets?: number
  spread?: number
  speed?: number[]
  badges: string[]
}

const pristine = new WeakMap<World, Entity>()
const targetOf = (w: World): Entity => w.entities.find((e) => e.kind === 'npc')!
const blastsOf = (w: World): (string | undefined)[] =>
  w.events.flatMap((e) => (e.type === 'explosion' ? [e.element] : []))
const explosions = (w: World): number => blastsOf(w).length
/** A shard, shrapnel or blast badge names the status of the element the sim gave it. */
const carrying = (label: string, element: string | undefined): string => {
  const status = element ? MODS[element]?.onHit?.status : undefined
  return status ? `${label} · ${status}` : label
}

/** Fire one pull and read what happened off the world, then reset for the next. */
const pull = (w: World): Fired => {
  const p = w.entities.find((e) => e.playerCtl)!
  const target = targetOf(w)
  if (!pristine.has(w)) pristine.set(w, structuredClone(target))
  Object.assign(target, structuredClone(pristine.get(w)!), { fx: undefined, lockout: undefined })
  w.events = []
  // A second copy with a one-hp target shows what a killing blow sets off.
  const melee = WEAPONS[p.combat!.weapon].kind === 'melee'
  const fragile = melee ? deserializeWorld(serializeWorld(w)) : undefined
  if (fragile) targetOf(fragile).health!.hp = 1
  const before = w.entities.length
  fireWeapon(w, p)
  const fired: Fired = { rate: SIM_RATE / Math.max(1, p.combat!.cooldown), damage: [], badges: [] }
  const shots = w.entities.slice(before).filter((e) => e.projectile)
  if (fragile) {
    const hit = w.events.find((e) => e.type === 'hit')
    fired.damage = hit && 'amount' in hit ? [hit.amount as number] : []
    fired.knockback = target.vel.x
    fireWeapon(fragile, fragile.entities.find((e) => e.playerCtl)!)
    const badges = Object.keys(target.fx ?? {}).map((k) => `${k} on hit`)
    // Stun and sleep ride their own timers on `status`, not `fx`.
    if (target.status && target.status.stun > 0) badges.push('stun on hit')
    if (target.status && target.status.sleep > 0) badges.push('sleep on hit')
    if (explosions(w) > 0) badges.push(carrying('On hit: blast', blastsOf(w)[0]))
    if (explosions(fragile) > explosions(w)) badges.push(carrying('On kill: blast', blastsOf(fragile).at(-1)))
    fired.badges = badges.sort()
  } else {
    fired.damage = shots.map((s) => s.projectile!.damage)
    fired.pellets = shots.length
    fired.speed = shots.map((s) => Math.hypot(s.vel.x, s.vel.y))
    if (shots.length > 1) fired.spread = Math.max(...shots.map((s) => s.facing)) - Math.min(...shots.map((s) => s.facing))
    const badges = new Set<string>()
    for (const { projectile: q } of shots) {
      if (q!.pierceLeft) badges.add(`Pierce ×${q!.pierceLeft}`)
      if (q!.bounceLeft) badges.add(`Bounce ×${q!.bounceLeft}`)
      if (q!.homing) badges.add('Homing')
      if (q!.explode) badges.add(carrying(`Explosive (${q!.explode.damage})`, q!.explode.element))
      if (q!.split) badges.add(carrying(`Split ×${q!.split.count}`, q!.split.element))
      if (q!.splinter) badges.add(carrying(`Splinter ×${q!.splinter.count}`, q!.splinter.element))
      if (q!.lifestealFrac) badges.add(`Lifesteal ${Math.round(q!.lifestealFrac * 100)}%`)
      if (q!.onHit) badges.add(`${q!.onHit.status} on hit`)
      for (const t of q!.triggers ?? []) badges.add(carrying(`On ${t.event}: blast`, t.explode?.element))
    }
    fired.badges = [...badges].sort()
  }
  // Reset: the next pull fires at once, from the index the sim stored.
  w.entities = w.entities.filter((e) => !e.projectile)
  for (const e of shots) w.byId.delete(e.id)
  p.combat!.cooldown = 0
  delete weaponStack(p)!.rechargeUntil
  return fired
}

/** The panel's claims, in the same shape as a fired pull. */
const shown = (model: LoadoutModel, melee: boolean): Record<string, string | string[] | undefined> => {
  const stat = (k: string) => model.stats.find((s) => s.key === k)?.resolvedText
  const out: Record<string, string | string[] | undefined> = { rate: stat('fireRate'), damage: stat('damage') }
  if (melee) out.knockback = stat('knockback')
  else Object.assign(out, { pellets: stat('pellets'), spread: stat('spread'), speed: stat('speed') })
  out.badges = model.behaviors.map((b) => b.label).sort()
  return out
}
const expected = (f: Fired, melee: boolean): Record<string, string | string[] | undefined> => {
  const out: Record<string, string | string[] | undefined> = {
    rate: `${round(f.rate, 1)}/s`,
    damage: text(f.damage, (n) => String(round(n))),
  }
  if (melee) out.knockback = String(round(f.knockback!, 1))
  else
    Object.assign(out, {
      pellets: String(f.pellets),
      spread: f.spread === undefined ? undefined : `${round((f.spread * 180) / Math.PI)}°`,
      speed: text(f.speed!, (n) => String(round(n, 1))),
    })
  out.badges = f.badges
  return out
}

/** Lists to check: none, each single, every ordered pair, a stacked mod, and
 * a deterministic spread of three-mod wands (including the review's shotgun). */
const LISTS: WeaponMod[][] = [
  [],
  ...MOD_IDS.map((a) => [m(a)]),
  ...MOD_IDS.flatMap((a) => MOD_IDS.filter((b) => b !== a).map((b) => [m(a), m(b)])),
  [m('bulk', 2)],
  [m('rapid', 3), m('frost')],
  [m('frost'), m('bulk'), m('shock')],
  [m('rapid'), m('frost'), m('shock'), m('incendiary')],
  // An element that loses the round can still ride a shard or blast (#119).
  ...['split', 'splinterShot', 'explosive', 'detonator'].map((id) => [m('frost'), m(id), m('rapid'), m('shock')]),
  [m('shock'), m('split'), m('explosive'), m('frost')],
  ...MOD_IDS.map((_, i) => [m(MOD_IDS[i]), m(MOD_IDS[(i * 5 + 3) % 18]), m(MOD_IDS[(i * 7 + 11) % 18])]).filter(
    (l) => new Set(l.map((x) => x.id)).size === 3,
  ),
]

describe('loadout panel equals the fired pull', () => {
  for (const weaponId of WEAPON_IDS) {
    it(weaponId, () => {
      const melee = WEAPONS[weaponId].kind === 'melee'
      const pulls = sequenceShape(WEAPONS[weaponId]).slots + 1
      const lies: string[] = []
      for (const list of LISTS) {
        const w = rig(weaponId, list)
        const p = w.entities.find((e) => e.playerCtl)!
        for (let n = 0; n < pulls; n++) {
          const claim = shown(buildLoadout(p)!, melee)
          const truth = expected(pull(w), melee)
          if (JSON.stringify(claim) !== JSON.stringify(truth))
            lies.push(`[${list.map((x) => x.id)}] pull ${n}: shown ${JSON.stringify(claim)} fired ${JSON.stringify(truth)}`)
        }
      }
      expect(lies.slice(0, 5)).toEqual([])
    })
  }
})

// Numeric fired fields and which direction is better for the shooter.
const BETTER: [keyof Fired, 1 | -1][] = [['rate', 1], ['knockback', 1], ['pellets', 1], ['spread', -1]]
const sum = (xs: number[] | undefined): number => (xs ?? []).reduce((a, b) => a + b, 0)

/** -1 when every fired change is a worsening, +1 when any is an improvement or
 * a behaviour change, 0 when nothing changed. */
const firedDirection = (withIt: Fired, without: Fired): -1 | 0 | 1 => {
  const worse: boolean[] = []
  const num = (a: number | undefined, b: number | undefined, dir: 1 | -1) => {
    if (round(a ?? 0, 6) !== round(b ?? 0, 6)) worse.push((a ?? 0) * dir < (b ?? 0) * dir)
  }
  for (const [k, dir] of BETTER) num(withIt[k] as number | undefined, without[k] as number | undefined, dir)
  num(sum(withIt.damage), sum(without.damage), 1)
  num(sum(withIt.speed), sum(without.speed), 1)
  if (JSON.stringify(withIt.badges) !== JSON.stringify(without.badges)) worse.push(false)
  if (worse.length === 0) return 0
  return worse.every(Boolean) ? -1 : 1
}

describe('penalty and live chips match the fired change, one-cast wands', () => {
  // A one-cast wand fires its whole list every pull, so one pull with and one
  // without the mod is the whole comparison.
  for (const weaponId of WEAPON_IDS) {
    it(weaponId, () => {
      const wrong: string[] = []
      const shape = sequenceShape(WEAPONS[weaponId])
      for (const list of LISTS.filter((l) => l.length > 0 && l.length <= 2 && cycleCasts(l, shape) === 1)) {
        const withIt = pull(rig(weaponId, list))
        const id = list[list.length - 1].id
        const without = pull(rig(weaponId, list.slice(0, -1)))
        const fired = firedDirection(withIt, without)
        const verdict = modVerdict(WEAPONS[weaponId], list, id).kind
        const want = fired === 0 ? 'inert' : fired < 0 ? 'penalty' : 'live'
        if (verdict !== want) wrong.push(`${id} after [${list.slice(0, -1).map((x) => x.id)}]: shown ${verdict}, fired ${want}`)
      }
      expect(wrong.slice(0, 5)).toEqual([])
    })
  }
})

describe('the review probes, pinned', () => {
  const panel = (weaponId: string, mods: WeaponMod[]): LoadoutModel => {
    const w = rig(weaponId, mods)
    return buildLoadout(w.entities.find((e: Entity) => e.playerCtl)!)!
  }
  const stat = (l: LoadoutModel, k: string) => l.stats.find((s) => s.key === k)!.resolvedText

  it('a pistol with only Rapid is one cast, so it fires at the Rapid rate, not the recharge (#115)', () => {
    expect(stat(panel('pistol', [m('rapid')]), 'fireRate')).toBe('2/s')
  })
  it('a pistol [frost, rapid] wraps on the Rapid cast, so its next pull after frost waits out the recharge', () => {
    const w = rig('pistol', [m('frost'), m('rapid')])
    const p = w.entities.find((e: Entity) => e.playerCtl)!
    weaponStack(p)!.castIndex = 1
    expect(stat(buildLoadout(p)!, 'fireRate')).toBe('1.5/s')
  })
  it('a shotgun [frost, bulk, shock] shows both casts: 7 pellets, both elements, the 30-tick recharge', () => {
    const l = panel('shotgun', [m('frost'), m('bulk'), m('shock')])
    expect(stat(l, 'pellets')).toBe('7')
    expect(stat(l, 'fireRate')).toBe('1/s')
    expect(l.behaviors.filter((b) => b.key === 'onhit').map((b) => b.label).sort()).toEqual(['electrified on hit', 'frozen on hit'])
  })
  it("a player's sledgehammer shows the player melee bonus: 33 bare, 26 with Barrage", () => {
    expect(stat(panel('sledgehammer', []), 'damage')).toBe('33')
    expect(stat(panel('sledgehammer', [m('bulk')]), 'damage')).toBe('26')
  })
})
