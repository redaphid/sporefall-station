// @vitest-environment happy-dom
// #88: the loadout, pickup and draft UIs show what the fire path will execute.
// Each case sets world state exactly (serialize → deserialize), runs the real
// systems, and then asserts both what the sim did and what the UI says about it.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { draftCards } from '../game/systems/draft'
import { weaponStack } from '../game/systems/inventory'
import { WEAPONS } from '../game/data/items'
import { arm, runTicks } from '../game/testkit'
import { addEntity, createWorld, type World } from '../game/world'
import { buildInfoCard } from './inspectModel'
import { buildLoadout, selfModVerdict } from './loadoutModel'
import { createLoadoutPanel } from './loadoutPanel'
import { createDraftScreen } from './draftScreen'
import { buildSequence } from './sequenceModel'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

/** Two players, host-authoritative: player 0 with a pistol, player 1 with a
 * sledgehammer, each carrying mods. Round-tripped through the save format so
 * the test starts from exact, serializable state. */
const coop = (sequenced = false): World => {
  const w = createWorld(7, 1)
  if (sequenced) w.modCasting = 'sequence'
  const gunner = spawnPlayer(w, 0, 20.5, 20.5)
  gunner.facing = 0
  weaponStack(gunner)!.mods = [m('frost'), m('shock'), m('choke')]
  const bruiser = spawnPlayer(w, 1, 20.5, 23.5)
  bruiser.loadout!.inventory = []
  arm(bruiser, 'sledgehammer').mods = [m('pierce'), m('bulk'), m('incendiary')]
  return deserializeWorld(serializeWorld(w))
}
const player = (w: World, id: number): Entity => w.entities.find((e) => e.playerCtl?.playerId === id)!
const fire = new Map([
  [0, { attack: true }],
  [1, { attack: true }],
])
const chip = (e: Entity, id: string, seq?: 'sequence') => buildLoadout(e, seq)!.mods.find((c) => c.id === id)!.verdict

describe('loadout: default casting', () => {
  it('the gun shows only the element its bullets carry, and the sim agrees', () => {
    const w = coop()
    runTicks(w, fire, 3)
    const gunner = player(w, 0)
    const shots = w.entities.filter((e) => e.projectile?.ownerId === gunner.id)
    expect(shots.length).toBeGreaterThan(0)
    expect(new Set(shots.map((s) => s.projectile!.onHit?.status))).toEqual(new Set(['electrified']))

    expect(chip(gunner, 'frost')).toEqual({ kind: 'inert', reason: 'Tesla Rounds overrides it' })
    expect(chip(gunner, 'shock')).toEqual({ kind: 'live' })
    expect(chip(gunner, 'choke')).toEqual({ kind: 'inert', reason: 'no effect on this gun' })
    const model = buildLoadout(gunner)!
    expect(model.behaviors.filter((b) => b.key === 'onhit').map((b) => b.label)).toEqual(['electrified on hit'])
    expect(model.stats.map((s) => s.key)).not.toContain('knockback')
    expect(model.stats.map((s) => s.key)).not.toContain('spread')
    expect(model.statsScope).toBe('every shot')
  })

  it('the sledgehammer never advertises bullet effects, and says Barrage only costs damage', () => {
    const w = coop()
    const bruiser = player(w, 1)
    expect(chip(bruiser, 'pierce')).toEqual({ kind: 'inert', reason: 'no effect on melee' })
    expect(chip(bruiser, 'bulk')).toEqual({ kind: 'penalty', reason: 'only lowers damage' })
    expect(chip(bruiser, 'incendiary')).toEqual({ kind: 'live' })
    const model = buildLoadout(bruiser)!
    expect(model.behaviors.map((b) => b.key)).toEqual(['onhit'])
    const dmg = model.stats.find((s) => s.key === 'damage')!
    expect(dmg.direction).toBe(-1)
    expect(dmg.resolvedText).toBe(String(Math.round(WEAPONS.sledgehammer.damage * 0.8)))
    expect(model.stats.map((s) => s.key)).toContain('knockback')
  })

  it('a dead player still gets the truthful panel on the death screen', () => {
    const w = coop()
    const bruiser = player(w, 1)
    bruiser.health!.hp = 0
    bruiser.dead = true
    runTicks(w, fire, 5)
    expect(chip(bruiser, 'pierce')).toEqual({ kind: 'inert', reason: 'no effect on melee' })
  })
})

describe('loadout: sequenced casting', () => {
  it('both elements are live because each fires on its own shot, and stats describe the next shot', () => {
    const w = coop(true)
    const gunner = player(w, 0)
    expect(chip(gunner, 'frost', 'sequence')).toEqual({ kind: 'live' })
    expect(chip(gunner, 'shock', 'sequence')).toEqual({ kind: 'live' })
    const model = buildLoadout(gunner, 'sequence')!
    expect(model.statsScope).toBe('next shot')
    expect(model.behaviors.find((b) => b.key === 'onhit')!.label).toBe('frozen on hit')
    runTicks(w, fire, 1)
    const shot = w.entities.find((e) => e.projectile?.ownerId === gunner.id)!
    expect(shot.projectile!.onHit?.status).toBe('frozen')
    // Next pull fires shock; the panel follows the sim's stored index.
    expect(buildLoadout(gunner, 'sequence')!.behaviors.find((b) => b.key === 'onhit')!.label).toBe('electrified on hit')
  })

  it('the HUD strip flags the choke riding a single-pellet cast', () => {
    const w = coop(true)
    const strip = buildSequence(player(w, 0), 'sequence', w.tick)!
    expect(strip.entries.find((e) => e.id === 'choke')!.verdict).toBe('no effect on this gun')
    expect(strip.entries.find((e) => e.id === 'frost')!.verdict).toBeUndefined()
  })
})

describe('pickups', () => {
  const dropMod = (w: World, modId: string, x: number, y: number): Entity => {
    const e = makeEntity('pickup', `mod.${modId}`, x, y, 0.3)
    e.pickup = { itemId: modId, qty: 1 }
    return addEntity(w, e)
  }

  it('an inspect card judges the pickup against the VIEWER\'s weapon, per co-op player', () => {
    const w = coop()
    const pk = dropMod(w, 'pierce', 30.5, 30.5)
    const row = (self?: Entity) => buildInfoCard(pk, { self }).rows.find((r) => r.label === 'On your weapon')
    expect(row(player(w, 1))?.value).toBe('no effect on melee')
    expect(row(player(w, 0))).toBeUndefined()
    expect(row(undefined)).toBeUndefined()
  })

  it('grabbing a dead mod says so, through the real auto-pickup', () => {
    const w = coop()
    const bruiser = player(w, 1)
    dropMod(w, 'homing', bruiser.pos.x, bruiser.pos.y)
    runTicks(w, new Map(), 1)
    const ev = w.events.find((e) => e.type === 'modPickup')
    expect(ev).toMatchObject({ byId: bruiser.id, modId: 'homing', maxed: false })
    expect(selfModVerdict(bruiser, 'homing', w.modCasting)).toEqual({ kind: 'inert', reason: 'no effect on melee' })
  })

  it('a player who joins mid-floor with a clean pistol sees choke as dead weight', () => {
    const w = coop()
    runTicks(w, fire, 20)
    const late = spawnPlayer(w, 2, 25.5, 20.5)
    const pk = dropMod(w, 'choke', 30.5, 30.5)
    expect(buildInfoCard(pk, { self: late }).rows.find((r) => r.label === 'On your weapon')?.value).toBe('no effect on this gun')
    expect(buildLoadout(late)!.mods).toEqual([])
  })

  it('an unarmed viewer gets no verdict rather than a wrong one', () => {
    const w = createWorld(7, 1)
    const p = spawnPlayer(w, 0, 20.5, 20.5)
    p.combat!.weapon = 'fists'
    expect(selfModVerdict(p, 'pierce', undefined)).toBeUndefined()
  })
})

describe('draft', () => {
  it('cards carry the verdict for the drafting player, and none without a weapon', () => {
    const w = coop()
    const bruiser = player(w, 1)
    const loadout = { weapon: WEAPONS.sledgehammer, mods: weaponStack(bruiser)!.mods!, sequenced: false }
    const cards = draftCards(['pierce', 'overload', 'incendiary'], loadout)
    expect(cards.map((c) => c.verdict)).toEqual([
      { kind: 'inert', reason: 'no effect on melee' },
      { kind: 'live' },
      { kind: 'inert', reason: 'already maxed' },
    ])
    expect(draftCards(['pierce']).map((c) => c.verdict)).toEqual([undefined])
  })
})

describe('DOM', () => {
  it('the loadout panel strikes an inert chip and prints its reason on the chip', () => {
    const w = coop()
    const panel = createLoadoutPanel()
    panel.update(buildLoadout(player(w, 1)))
    const pierce = panel.el.querySelector('[data-mod-id="pierce"]')!
    expect(pierce.getAttribute('data-verdict')).toBe('inert')
    expect(pierce.querySelector('.mod-verdict')!.textContent).toBe('no effect on melee')
    expect(panel.el.querySelector('[data-mod-id="bulk"] .mod-verdict')!.textContent).toBe('only lowers damage')
    expect(panel.el.querySelector('[data-mod-id="incendiary"] .mod-verdict')).toBeNull()
  })

  it('a draft card for a dead pick shows the reason in its face, not a tooltip', () => {
    const mount = document.createElement('div')
    const screen = createDraftScreen(mount)
    screen.show(['pierce', 'overload'], () => {}, { weapon: WEAPONS.sledgehammer, mods: [], sequenced: false })
    const card = (id: string) => mount.querySelector(`[data-mod-id="${id}"]`)!
    expect(card('pierce').querySelector('.draft-verdict')!.textContent).toBe('NO EFFECT ON MELEE')
    expect(card('overload').querySelector('.draft-verdict')).toBeNull()
  })
})
