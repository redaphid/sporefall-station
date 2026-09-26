// A default-mode bullet's provenance (`projectile.mods`) is what the renderer and
// every co-op peer build its look from, so it must list only what the shot
// executes. A gun holds every element the player picked, but a hit applies only
// the newest one (#106). The overridden elements must not ride the bullet, or a
// Tesla-then-Cryo round (which freezes) looks exactly like a Cryo-then-Tesla
// round (which zaps).
//
// Every case sets exact world state and fires through the real combat system.

import { describe, expect, it } from 'vitest'
import { MODS } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm } from '../testkit'
import { emptyInput } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { combatSystem } from './combat'
import { projectileSystem } from './projectiles'
import { weaponStack } from './inventory'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

const rig = (weapon = 'pistol', mods?: WeaponMod[]): { w: World; p: Entity } => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  const stack = arm(p, weapon)
  if (mods) stack.mods = mods.map((x) => ({ ...x }))
  p.facing = 0
  return { w, p }
}

/** One trigger pull; returns the rounds it spawned. */
const pull = (w: World, p: Entity): Entity[] => {
  const before = new Set(w.entities.map((e) => e.id))
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  return w.entities.filter((e) => !before.has(e.id) && e.kind === 'projectile')
}

const shoot = (mods: WeaponMod[], weapon = 'pistol'): Entity => {
  const { w, p } = rig(weapon, mods)
  const [b] = pull(w, p)
  return b
}

const isElement = (id: string): boolean => MODS[id]?.onHit !== undefined
const ids = (b: Entity): string[] => (b.projectile!.mods ?? []).map((x) => x.id)
const shownElements = (b: Entity): string[] => ids(b).filter(isElement)
/** The element mod whose status this round applies on a hit, or none. */
const landingElement = (b: Entity): string[] => {
  const status = b.projectile!.onHit?.status
  if (!status) return []
  return Object.values(MODS).filter((d) => d.onHit?.status === status).map((d) => d.id)
}

describe('default-mode bullet provenance lists only what executes', () => {
  it('Tesla then Cryo: the round freezes and carries frost, not shock', () => {
    const b = shoot([m('shock'), m('frost')])
    expect(b.projectile!.onHit?.status).toBe('frozen')
    expect(b.projectile!.mods).toEqual([m('frost')])
  })

  it('Cryo then Tesla: the round zaps and carries shock, not frost', () => {
    const b = shoot([m('frost'), m('shock')])
    expect(b.projectile!.onHit?.status).toBe('electrified')
    expect(b.projectile!.mods).toEqual([m('shock')])
  })

  it('the two orders no longer carry the same provenance', () => {
    expect(shoot([m('shock'), m('frost')]).projectile!.mods).not.toEqual(shoot([m('frost'), m('shock')]).projectile!.mods)
  })

  it('non-element mods all stay, with their stacks, around the winning element', () => {
    const b = shoot([m('shock'), m('pierce', 2), m('incendiary'), m('rapid', 3), m('frost'), m('overload')])
    expect(b.projectile!.onHit?.status).toBe('frozen')
    expect(b.projectile!.mods).toEqual([m('frost'), m('overload'), m('pierce', 2), m('rapid', 3)])
    expect(b.projectile!.pierceLeft).toBe(2)
  })

  it('a gun with only non-element mods keeps every one', () => {
    const b = shoot([m('pierce'), m('bounce'), m('lifesteal')])
    expect(b.projectile!.mods).toEqual([m('bounce'), m('lifesteal'), m('pierce')])
  })

  it('a newer element overrides the base weapon element, and only the mod shows', () => {
    const b = shoot([m('shock')], 'freezeRay')
    expect(b.projectile!.onHit?.status).toBe('electrified')
    expect(b.projectile!.mods).toEqual([m('shock')])
  })

  it('a repeated winning element still shows once, capped', () => {
    const b = shoot([m('frost'), m('shock'), m('frost')])
    expect(b.projectile!.onHit?.status).toBe('frozen')
    expect(b.projectile!.mods).toEqual([m('frost')])
  })

  it.each([
    ['a zero-stack element', [m('frost'), m('shock', 0)]],
    ['a negative-stack element', [m('frost'), m('shock', -2)]],
    ['a NaN-stack element', [m('frost'), m('shock', NaN)]],
    ['an unknown id', [m('frost'), m('no-such-mod')]],
  ])('%s after the winner neither lands nor shows', (_label, mods) => {
    const b = shoot(mods)
    expect(b.projectile!.onHit?.status).toBe('frozen')
    expect(b.projectile!.mods).toEqual([m('frost')])
  })

  it('every ordering of every subset: the element shown is the element that lands', () => {
    const pool = ['frost', 'incendiary', 'shock', 'pierce', 'rapid']
    const arrangements = (xs: string[]): string[][] =>
      [[] as string[]].concat(xs.flatMap((x, i) => arrangements([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])))
    const { w, p } = rig('pistol')
    const stack = weaponStack(p)!
    const lists = arrangements(pool)
    expect(lists).toHaveLength(326)
    for (const list of lists) {
      stack.mods = list.map((id) => m(id))
      const [b] = pull(w, p)
      const label = list.join(' > ') || '(none)'
      expect(shownElements(b), label).toEqual(landingElement(b))
      expect(ids(b).filter((id) => !isElement(id)), label).toEqual(list.filter((id) => !isElement(id)).sort())
    }
  })
})

describe('provenance survives the paths a round takes after it spawns', () => {
  it('split shards inherit the filtered provenance, never the overridden element', () => {
    const { w, p } = rig('pistol', [m('shock'), m('split'), m('frost')])
    const victim = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
    victim.health = { hp: 1, max: 40, iframes: 0 }
    const [parent] = pull(w, p)
    expect(parent.projectile!.mods).toEqual([m('frost'), m('split')])
    for (let i = 0; i < 30 && w.entities.some((e) => e.projectile?.split && !e.dead); i++) {
      projectileSystem(w)
      w.tick++
    }
    const shards = w.entities.filter((e) => e.kind === 'projectile' && !e.dead)
    expect(shards.length).toBeGreaterThan(0)
    for (const s of shards) expect(ids(s)).not.toContain('shock')
  })

  it('splinter fragments carry the winning element and only its provenance', () => {
    const { w, p } = rig('pistol', [m('frost'), m('splinterShot'), m('shock')])
    const [parent] = pull(w, p)
    parent.projectile!.ttl = 1
    projectileSystem(w)
    const frags = w.entities.filter((e) => e.kind === 'projectile' && !e.dead && e.id !== parent.id)
    expect(frags.length).toBeGreaterThan(0)
    for (const f of frags) {
      expect(f.projectile!.onHit?.status).toBe('electrified')
      expect(ids(f)).toEqual(['shock', 'splinterShot'])
    }
  })

  it('the filtered provenance round-trips through world serialization byte for byte', () => {
    const { w, p } = rig('pistol', [m('shock'), m('pierce'), m('frost')])
    pull(w, p)
    const json = serializeWorld(w)
    const back = deserializeWorld(json)
    const [b] = back.entities.filter((e) => e.kind === 'projectile')
    expect(b.projectile!.mods).toEqual([m('frost'), m('pierce')])
    expect(JSON.stringify(serializeWorld(back))).toBe(JSON.stringify(json))
  })
})
