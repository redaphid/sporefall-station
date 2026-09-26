// The display/behaviour contract for mods (#88): for every mod on every weapon,
// in both casting modes, `modVerdict` says "inert" exactly when firing the REAL
// weapon with the mod produces the same result as firing it without. A new mod
// whose effect the fire path ignores (or a fire-path change that stops reading a
// field) fails here instead of shipping a chip that lies.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { MODS } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../serialize'
import { arm } from '../testkit'
import { addEntity, createWorld, type World } from '../world'
import { fireWeapon } from './combat'
import { weaponStack } from './inventory'
import { isPayloadMod } from './modSequence'
import { modVerdict } from './modEffect'

const MOD_IDS = Object.keys(MODS)
const WEAPON_IDS = Object.keys(WEAPONS)
// An id the registry does not know: liveEntries/resolveWeapon skip it, so it
// stands in for "no mod here" while keeping the list non-empty (sequenced path).
const EMPTY_SLOT = '__none__'

const npc = (w: World, x: number, hp: number): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, 20.5))
  e.health = { hp, max: hp, iframes: 0 }
  return e
}

/** Shooter facing east at a target one tile away. `fragile` makes the target die
 * to any blow, with a bystander in blast range, so on-kill triggers show. */
const rig = (weaponId: string, sequenced: boolean, fragile: boolean): WorldJson => {
  const w = createWorld(1, 1)
  if (sequenced) w.modCasting = 'sequence'
  const p = spawnPlayer(w, 0, 20.5, 20.5)
  p.health!.iframes = 0
  p.loadout!.inventory = []
  arm(p, weaponId)
  p.facing = 0
  npc(w, 21.5, fragile ? 1 : 100000)
  if (fragile) npc(w, 22.7, 100000)
  return serializeWorld(w)
}

const rigs = new Map<string, WorldJson>()
const rigFor = (weaponId: string, sequenced: boolean, fragile: boolean): WorldJson => {
  const key = `${weaponId}/${sequenced}/${fragile}`
  if (!rigs.has(key)) rigs.set(key, rig(weaponId, sequenced, fragile))
  return rigs.get(key)!
}

/** Everything one trigger pull changed that the game plays out: projectiles as
 * spawned (minus `mods`, the renderer's provenance tag), what the swing did to
 * the bodies in front, events, and the shooter's cooldown. */
const pullOutcome = (weaponId: string, mods: WeaponMod[], sequenced: boolean): string => {
  const scenes = WEAPONS[weaponId].kind === 'melee' ? [false, true] : [false]
  return scenes
    .map((fragile) => {
      const w = deserializeWorld(rigFor(weaponId, sequenced, fragile))
      const p = w.entities.find((e) => e.playerCtl)!
      weaponStack(p)!.mods = mods.map((m) => ({ ...m }))
      fireWeapon(w, p)
      const shots = w.entities
        .filter((e) => e.projectile)
        .map((e) => ({ pos: e.pos, vel: e.vel, projectile: { ...e.projectile, mods: undefined } }))
      const bodies = w.entities.filter((e) => e.health && !e.playerCtl)
      return JSON.stringify({ shots, bodies, events: w.events, cooldown: p.combat!.cooldown })
    })
    .join('|')
}

const m = (id: string): WeaponMod => ({ id, stacks: 1 })

describe('mod verdict equals executed behaviour, default casting', () => {
  for (const weaponId of WEAPON_IDS) {
    // Both sides of every neighbour: list order picks the element, so an
    // element before another element is the one the fire path drops.
    it(`${weaponId}: every mod, alone, before and after every other mod`, () => {
      const disagreements: string[] = []
      for (const rest of [[], ...MOD_IDS.map((x) => [m(x)])]) {
        const without = pullOutcome(weaponId, rest, false)
        for (const id of MOD_IDS) {
          if (rest.some((r) => r.id === id)) continue
          for (const list of [[...rest, m(id)], [m(id), ...rest]]) {
            const inert = pullOutcome(weaponId, list, false) === without
            const verdict = modVerdict(WEAPONS[weaponId], list, id)
            if (inert !== (verdict.kind === 'inert')) disagreements.push(`${id} in [${list.map((r) => r.id)}]: fired ${inert ? 'inert' : 'live'}, shown ${verdict.kind}`)
          }
        }
      }
      expect(disagreements).toEqual([])
    })
  }
})

describe('mod verdict equals executed behaviour, sequenced casting', () => {
  // Single-cast lists only, so the cast the mod rides in is the whole pull and
  // cadence (wrap, recharge) is identical with and without it: a modifier
  // after another modifier, a modifier before each payload, and a payload
  // after each modifier.
  for (const weaponId of WEAPON_IDS) {
    it(`${weaponId}: every mod in a one-cast wand`, () => {
      const disagreements: string[] = []
      for (const id of MOD_IDS) {
        for (const x of MOD_IDS) {
          if (x === id) continue
          if (isPayloadMod(id) && isPayloadMod(x)) continue
          const before = isPayloadMod(x)
          const list = before ? [m(id), m(x)] : [m(x), m(id)]
          const hollow = list.map((e) => (e.id === id ? m(EMPTY_SLOT) : e))
          const inert = pullOutcome(weaponId, list, true) === pullOutcome(weaponId, hollow, true)
          const verdict = modVerdict(WEAPONS[weaponId], list, id, true)
          if (inert !== (verdict.kind === 'inert')) disagreements.push(`${id} in [${list.map((e) => e.id)}]: fired ${inert ? 'inert' : 'live'}, shown ${verdict.kind}`)
        }
      }
      expect(disagreements).toEqual([])
    })
  }
})

describe('mod verdict equals executed behaviour, an element riding a shard or blast', () => {
  // A losing element is not inert when a shard, shrapnel or blast carries it
  // (#119): every ordering of two elements, one self-hitting mod and a filler.
  const orderings = (xs: string[]): string[][] =>
    xs.length === 0 ? [[]] : xs.flatMap((x, i) => orderings([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]))
  for (const weaponId of ['pistol', 'shotgun', 'sledgehammer']) {
    it(`${weaponId}: every ordering of frost, shock, a self-hitting mod and rapid`, () => {
      const disagreements: string[] = []
      let rides = 0
      for (const self of ['split', 'splinterShot', 'explosive', 'detonator']) {
        for (const order of orderings(['frost', 'shock', self, 'rapid'])) {
          const list = order.map(m)
          for (const id of ['frost', 'shock']) {
            const inert = pullOutcome(weaponId, list, false) === pullOutcome(weaponId, list.filter((x) => x.id !== id), false)
            const verdict = modVerdict(WEAPONS[weaponId], list, id)
            if (!inert && id !== order.filter((x) => x === 'frost' || x === 'shock').at(-1)) rides++
            if (inert !== (verdict.kind === 'inert')) disagreements.push(`${id} in [${order}]: fired ${inert ? 'inert' : 'live'}, shown ${verdict.kind}`)
          }
        }
      }
      expect(disagreements).toEqual([])
      if (weaponId !== 'sledgehammer') expect(rides).toBeGreaterThan(0)
    })
  }
})

describe('verdict reasons', () => {
  it('every inert or penalty reason, on every weapon and mode, is five words or fewer', () => {
    for (const weaponId of WEAPON_IDS)
      for (const sequenced of [false, true])
        for (const id of MOD_IDS)
          for (const x of [undefined, ...MOD_IDS])
            for (const list of x && x !== id ? [[m(x), m(id)], [m(id), m(x)]] : [[m(id)]]) {
              const v = modVerdict(WEAPONS[weaponId], list, id, sequenced)
              if (v.kind !== 'live') expect(v.reason.split(/\s+/).length, `${weaponId} [${list.map((e) => e.id)}] ${id}: ${v.reason}`).toBeLessThanOrEqual(5)
            }
  })
})
