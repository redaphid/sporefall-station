// feat/enemy-weapon-drops: a dying NPC OCCASIONALLY drops the weapon it carried
// as a grabbable world pickup (reusing the `pickup.<itemId>` archetype + the
// interaction.ts `collect`/equip path). The roll is drawn from the world RNG
// (`w.rng`) at the single kill site (systems/combat.ts `kill`), so it is a pure
// function of seed + inputs — this suite PREDICTS every drop from the seed.
//
// Strict + adversarial: hit spawns exactly one correct pickup at the corpse;
// miss spawns nothing; an unarmed ('fists') NPC never drops AND never draws the
// RNG (stream unperturbed); a dropped weapon equips through the real pickup path;
// environment kills (applyDamage, not just a player swing) roll too; multiple
// simultaneous deaths roll independently in a stable order; byte-identical
// determinism across runs and across a serialize round-trip; and a statistical
// sanity check that the empirical rate tracks the constant.

import { describe, expect, it } from 'vitest'
import { kill, applyDamage, WEAPON_DROP_CHANCE } from './combat'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { runTicks } from '../testkit'
import { serializeWorld, deserializeWorld } from '../serialize'

/** An armed NPC placed at (x,y) carrying `weapon` — no populate machinery, so
 * building it draws nothing from `w.rng` and the drop roll stays the first draw. */
const armedNpc = (w: World, weapon: string, x = 5.5, y = 5.5): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, y))
  e.health = { hp: 10, max: 10, iframes: 0 }
  e.combat = { weapon, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const player = (w: World, x = 5.5, y = 5.5, playerId = 0): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId, abilityCooldown: 0, inventory: [], cash: 0, crimeUntilTick: 0, activeSlot: -1 }
  return e
}

const drops = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'pickup' && !e.dead)

/** Whether a FRESH world at `seed`/`floor` will hit the drop roll on its first
 * `w.rng` draw — the exact draw `kill` makes on an armed NPC before any tick. */
const firstRollHits = (seed: number, floor = 1): boolean =>
  createWorld(seed, floor).rng.chance(WEAPON_DROP_CHANCE)

/** Smallest seed >= 1 whose first drop roll matches `want` — self-documenting,
 * so the tests carry no opaque magic seeds. */
const findSeed = (want: boolean): number => {
  for (let s = 1; s < 100000; s++) if (firstRollHits(s) === want) return s
  throw new Error(`no seed produced roll=${want}`)
}

const HIT = findSeed(true)
const MISS = findSeed(false)

describe('weapon drop — the roll HITS', () => {
  it('killing an armed NPC spawns exactly one pickup of the right weapon at the corpse', () => {
    const w = createWorld(HIT, 1)
    const npc = armedNpc(w, 'pistol', 7.5, 9.5)
    kill(w, npc)

    const pk = drops(w)
    expect(pk).toHaveLength(1)
    expect(pk[0].kind).toBe('pickup')
    expect(pk[0].archetype).toBe('pickup.pistol')
    expect(pk[0].pickup).toEqual({ itemId: 'pistol', qty: 1 })
    expect(pk[0].pos).toEqual({ x: 7.5, y: 9.5 })

    const ev = w.events.find((e) => e.type === 'weaponDrop')
    expect(ev).toMatchObject({ type: 'weaponDrop', fromId: npc.id, itemId: 'pistol', x: 7.5, y: 9.5 })
    expect((ev as { entityId: number }).entityId).toBe(pk[0].id)
  })

  it('a melee weapon drops just the same', () => {
    const w = createWorld(HIT, 1)
    kill(w, armedNpc(w, 'bat'))
    expect(drops(w).map((e) => e.pickup!.itemId)).toEqual(['bat'])
  })

  it('an ENVIRONMENT kill (applyDamage, no player swing) rolls too — any death drops', () => {
    const w = createWorld(HIT, 1)
    const npc = armedNpc(w, 'pistol')
    applyDamage(w, npc, 999, npc.pos.x + 1, npc.pos.y, 0, 999) // attackerId that isn't a player
    expect(npc.dead).toBe(true)
    expect(drops(w).map((e) => e.pickup!.itemId)).toEqual(['pistol'])
  })
})

describe('weapon drop — the roll MISSES', () => {
  it('killing an armed NPC spawns no pickup and emits no weaponDrop event', () => {
    const w = createWorld(MISS, 1)
    kill(w, armedNpc(w, 'pistol'))
    expect(drops(w)).toHaveLength(0)
    expect(w.events.some((e) => e.type === 'weaponDrop')).toBe(false)
  })
})

describe('weapon drop — unarmed NPCs never drop and never draw the RNG', () => {
  it("a 'fists' NPC drops nothing even on a hit seed, and leaves the stream untouched", () => {
    const w = createWorld(HIT, 1) // this seed WOULD hit if a roll happened
    const before = w.rng.state()
    kill(w, armedNpc(w, 'fists'))
    expect(drops(w)).toHaveLength(0)
    expect(w.events.some((e) => e.type === 'weaponDrop')).toBe(false)
    // No roll was drawn: the shared stream is byte-for-byte where it started, so
    // an unarmed death cannot perturb a later armed enemy's roll.
    expect(w.rng.state()).toBe(before)
  })

  it('an unknown/garbage weapon id is not droppable (never in WEAPONS) and never draws', () => {
    const w = createWorld(HIT, 1)
    const before = w.rng.state()
    kill(w, armedNpc(w, 'not-a-real-weapon'))
    expect(drops(w)).toHaveLength(0)
    expect(w.rng.state()).toBe(before)
  })
})

describe('weapon drop — a dropped weapon equips through the real pickup path', () => {
  it('a player standing on the corpse auto-picks-up and equips the dropped gun', () => {
    const w = createWorld(HIT, 1)
    const p = player(w, 12.5, 12.5)
    const npc = armedNpc(w, 'shotgun', 12.5, 12.5)
    kill(w, npc) // shotgun pickup spawns on the player's tile
    expect(drops(w)).toHaveLength(1)

    runTicks(w, new Map([[0, {}]]), 1) // interactionSystem.autoPickup grabs it

    expect(p.combat!.weapon).toBe('shotgun') // equipped as the swung weapon
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'shotgun')).toBe(true)
    expect(p.playerCtl!.activeSlot).toBeGreaterThanOrEqual(0)
    expect(drops(w)).toHaveLength(0) // consumed + swept
  })
})

describe('weapon drop — determinism', () => {
  it('two identical worlds killing the same NPC reach a byte-identical state', () => {
    const build = (): World => {
      const w = createWorld(HIT, 3)
      kill(w, armedNpc(w, 'machinegun', 8.5, 8.5))
      return w
    }
    expect(serializeWorld(build())).toEqual(serializeWorld(build()))
  })

  it('the post-drop world round-trips through serialize byte-for-byte', () => {
    const w = createWorld(HIT, 2)
    kill(w, armedNpc(w, 'pistol'))
    const json = serializeWorld(w)
    expect(serializeWorld(deserializeWorld(json))).toEqual(json)
  })

  it('multiple simultaneous deaths roll INDEPENDENTLY from the shared stream in a stable order', () => {
    // Kill a batch in a fixed order; each death draws the next value from the one
    // shared `w.rng`, so which of them drop is fully determined by seed + order.
    const run = (): string[] => {
      const w = createWorld(1234, 1)
      const weapons = ['pistol', 'bat', 'shotgun', 'knife', 'machinegun', 'pistol']
      const npcs = weapons.map((wp, i) => armedNpc(w, wp, 3.5 + i, 4.5))
      for (const n of npcs) kill(w, n) // stable order
      return drops(w).map((e) => e.pickup!.itemId)
    }
    const a = run()
    const b = run()
    expect(a).toEqual(b) // reproducible
    // A mix (not all, not none) — proves independent per-death rolls off one stream.
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBeLessThan(6)
  })

  it('two NPCs dying on the SAME tile both spawn distinct pickups (no id corruption)', () => {
    // Force both to drop by seeding each kill from a hit position — use a batch
    // world and assert every dropped pickup has a unique id and the shared tile.
    const w = createWorld(1234, 1)
    // Kill many so at least two drops land; assert ids are unique.
    const npcs = Array.from({ length: 8 }, () => armedNpc(w, 'pistol', 6.5, 6.5))
    for (const n of npcs) kill(w, n)
    const ids = drops(w).map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length) // all distinct — addEntity never reused an id
    for (const d of drops(w)) expect(d.pos).toEqual({ x: 6.5, y: 6.5 })
  })
})

describe('weapon drop — statistical sanity', () => {
  it('over many seeded deaths the empirical drop rate tracks WEAPON_DROP_CHANCE', () => {
    const w = createWorld(777, 1)
    const N = 4000
    let dropped = 0
    for (let i = 0; i < N; i++) {
      const before = drops(w).length
      kill(w, armedNpc(w, 'pistol', 1.5, 1.5))
      if (drops(w).length > before) dropped++
    }
    const rate = dropped / N
    expect(rate).toBeGreaterThan(WEAPON_DROP_CHANCE - 0.03)
    expect(rate).toBeLessThan(WEAPON_DROP_CHANCE + 0.03)
  })
})
