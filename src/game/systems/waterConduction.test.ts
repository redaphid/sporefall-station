// SHOCK CONDUCTION THROUGH WATER CELLS (systems/interactions.ts).
//
// `shock` used to flood over WET BODIES only, so a dry origin was a dead end and
// a puddle was scenery. Now a `water` cell is a conductor in its own right:
// shock the ground and the charge runs the whole connected pool, electrocuting
// everything standing anywhere in it.
//
// THE FRIENDLY-FIRE RULE IS DELIBERATE AND SYMMETRIC. A player standing in the
// puddle they are shooting into is electrocuted by their own shot. There is no
// "water conducts, but politely not to you" exemption. These tests exist to pin
// the three things that make that fair rather than cheap:
//
//   1. the DOWNED protection still holds — an arc can never re-kill a downed
//      player (#52), even though their body still conducts;
//   2. it CANNOT CHAIN-LOCK. `electrified` is an IMMOBILIZE_STATUS, so every arc
//      routes through statusFx.applyImmobilize and inherits no-refresh-while-
//      active, a post-lock immunity window and diminishing returns. The
//      adversarial case — two sources shocking one puddle forever — must still
//      leave the victim actionable ticks, and those ticks must be ENOUGH TO WALK
//      OUT, which is the only counterplay that matters;
//   3. it is TELEGRAPHED — you are soaked (a rendered status) and the puddle is
//      a visible entity before any of this can kill you.
//
// And the mechanic it extends must not regress: body-to-body chaining through a
// soaked huddle is a shipped, beloved behaviour (docs/gameplay-experiments.md).

import { beforeEach, describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { serializeWorld } from '../serialize'
import { buildSnapshot } from '../snapshot'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { ELEC_DAMAGE, shock, shockCell, wet } from './interactions'
import { hasStatus, IMMOBILIZE_IMMUNE_TICKS, isImmobilized } from './statusFx'
import { floodCell, waterAt } from './water'

const findOpenRect = (w: World, rw: number, rh: number): { x: number; y: number } => {
  for (let y = 1; y < w.level.h - rh; y++) {
    for (let x = 1; x < w.level.w - rw; x++) {
      let ok = true
      for (let dy = 0; dy < rh && ok; dy++) {
        for (let dx = 0; dx < rw; dx++) {
          if (isSolidTile(w.level, x + dx, y + dy)) {
            ok = false
            break
          }
        }
      }
      if (ok) return { x, y }
    }
  }
  throw new Error(`no open ${rw}x${rh} area in this level`)
}

const body = (w: World, tx: number, ty: number, hp = 100): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', tx + 0.5, ty + 0.5))
  e.health = { hp, max: hp, iframes: 0 }
  e.ai = undefined
  return e
}

const player = (w: World, tx: number, ty: number, hp = 100): Entity => {
  const p = spawnPlayer(w, 0, tx + 0.5, ty + 0.5)
  p.health = { hp, max: hp, iframes: 0 }
  return p
}

/** Flood a horizontal run of cells and hand back its coordinates. */
const pool = (w: World, x: number, y: number, n: number): void => {
  for (let i = 0; i < n; i++) floodCell(w, x + i, y)
}

const noInput = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

describe('conduction through water — the charge runs the pool, not just the bodies', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('shocking a body in a puddle reaches a body at the far end of that pool', () => {
    const { x, y } = findOpenRect(w, 6, 1)
    pool(w, x, y, 6)
    const near = body(w, x, y)
    const far = body(w, x + 5, y)
    // 5 tiles apart: far beyond CHAIN_RADIUS (1.6), so a body-to-body arc could
    // never bridge this. Only the water can.
    shock(w, near)
    expect(hasStatus(far, 'electrified')).toBe(true)
    expect(far.health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('shockCell electrifies everyone in the pool — "shoot the ground, not the boss"', () => {
    const { x, y } = findOpenRect(w, 5, 1)
    pool(w, x, y, 5)
    const a = body(w, x, y)
    const b = body(w, x + 4, y)
    shockCell(w, x + 2, y) // an empty cell in the middle of the pool
    for (const e of [a, b]) {
      expect(hasStatus(e, 'electrified')).toBe(true)
      expect(e.health!.hp).toBe(100 - ELEC_DAMAGE)
    }
  })

  it('shocking a puddle ENTITY directly floods it (the debug verb aimed at water)', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    pool(w, x, y, 3)
    const victim = body(w, x + 2, y)
    const puddle = w.entities.find((e) => e.water)!
    shock(w, puddle)
    expect(hasStatus(victim, 'electrified')).toBe(true)
    expect(victim.health!.hp).toBeLessThan(100)
  })

  it('a body standing in water conducts even before it has been soaked', () => {
    // waterSystem hands out `wet` on the next tick; the ground is conductive NOW.
    const { x, y } = findOpenRect(w, 4, 1)
    pool(w, x, y, 4)
    const e = body(w, x + 3, y)
    expect(hasStatus(e, 'wet')).toBe(false)
    shockCell(w, x, y)
    expect(hasStatus(e, 'electrified')).toBe(true)
    expect(e.health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('DRY GROUND IS NOT A CONDUCTOR: shocking a bare tile does nothing at all', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    const e = body(w, x, y)
    shockCell(w, x, y)
    expect(hasStatus(e, 'electrified')).toBe(false)
    expect(e.health!.hp).toBe(100)
  })

  it('the pool does NOT conduct across a diagonal gap', () => {
    // Two runs touching only corner-to-corner. Water connects through shared
    // EDGES, so this is a real break in the circuit — and the bodies are 5 tiles
    // apart, so no body-to-body arc can bridge it either.
    const { x, y } = findOpenRect(w, 6, 2)
    pool(w, x, y, 3) // (x..x+2, y)
    pool(w, x + 3, y + 1, 3) // (x+3..x+5, y+1) — diagonal from (x+2,y)
    const a = body(w, x, y)
    const b = body(w, x + 5, y + 1)
    shock(w, a)
    expect(hasStatus(a, 'electrified')).toBe(true)
    expect(hasStatus(b, 'electrified')).toBe(false)
    expect(b.health!.hp).toBe(100)
  })

  it('…and DOES conduct once one orthogonal cell bridges the two runs', () => {
    const { x, y } = findOpenRect(w, 6, 2)
    pool(w, x, y, 3)
    pool(w, x + 3, y + 1, 3)
    floodCell(w, x + 3, y) // the bridge: orthogonal to both runs
    const a = body(w, x, y)
    const b = body(w, x + 5, y + 1)
    shock(w, a)
    expect(hasStatus(b, 'electrified')).toBe(true)
    expect(b.health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('a puddle cell never becomes an actor — hazard cells collect no status', () => {
    const { x, y } = findOpenRect(w, 4, 1)
    pool(w, x, y, 4)
    body(w, x, y)
    shockCell(w, x, y)
    for (const e of w.entities) {
      if (e.water || e.fire || e.spore) expect(e.fx, `hazard cell ${e.archetype} took a status`).toBeUndefined()
    }
  })

  it('is deterministic: the same pool shocked twice resolves identically', () => {
    const run = (): string => {
      const world = createWorld(7, 1)
      const { x, y } = findOpenRect(world, 5, 1)
      pool(world, x, y, 5)
      body(world, x, y)
      body(world, x + 2, y)
      body(world, x + 4, y)
      shockCell(world, x + 1, y)
      return JSON.stringify(serializeWorld(world).entities)
    }
    expect(run()).toBe(run())
  })
})

describe('conduction through water — the friendly-fire call, and what keeps it fair', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('SYMMETRIC: a player standing in the puddle they shoot into is electrocuted too', () => {
    const { x, y } = findOpenRect(w, 5, 1)
    pool(w, x, y, 5)
    const p = player(w, x, y)
    const target = body(w, x + 4, y)
    // The player zaps the ground at the enemy's feet, four tiles away — well
    // outside CHAIN_RADIUS, so this can only come back through the water.
    shockCell(w, x + 4, y)
    expect(target.health!.hp).toBe(100 - ELEC_DAMAGE)
    expect(p.health!.hp).toBe(100 - ELEC_DAMAGE) // the danger IS the mechanic
    expect(hasStatus(p, 'electrified')).toBe(true)
  })

  it('DOWNED: an arc electrifies a downed player but can never re-kill them (#52)', () => {
    const { x, y } = findOpenRect(w, 4, 1)
    pool(w, x, y, 4)
    const p = player(w, x, y, 10) // on death's door
    p.playerCtl!.downed = { bleedTicks: 9999, reviveProgress: 0 }
    const alive = body(w, x + 3, y)
    shockCell(w, x + 1, y)
    expect(p.health!.hp).toBe(10) // untouched — the guard held
    expect(p.dead).toBeFalsy()
    // The rest of the pool is still live wire; the downed body is not a fuse.
    expect(alive.health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('PINNED: an arc is environmental — i-frames do not insulate you from standing in it', () => {
    // Deliberate, and inherited unchanged from the body-chain rule: this damage
    // site bypasses combat.applyDamage entirely. Invulnerability frames stop
    // BLOWS; they are not rubber boots. The counterplay to electrified water is
    // to leave the water (see the escape test below), which is exactly what the
    // dodge-roll is for — so the roll still answers this, by moving you.
    const { x, y } = findOpenRect(w, 3, 1)
    pool(w, x, y, 3)
    const e = body(w, x, y)
    e.health!.iframes = 90 // full spawn grace
    shockCell(w, x, y)
    expect(e.health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('ADVERSARIAL: two sources shocking one puddle forever cannot chain-lock the player', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    pool(w, x, y, 3)
    // hp is irrelevant here and deliberately huge: this test measures the LOCK,
    // not lethality. Lethality is the escape test's job.
    const p = player(w, x + 1, y, 100000)

    const immobilizedPerTick: boolean[] = []
    for (let t = 0; t < 300; t++) {
      immobilizedPerTick.push(isImmobilized(p)) // as movement/combat read it
      if (w.tick % 24 === 0) shockCell(w, x, y) // attacker A
      if (w.tick % 24 === 12) shockCell(w, x + 2, y) // attacker B, offset, other end
      tickWorld(w, noInput())
    }

    const free = immobilizedPerTick.filter((im) => !im).length
    expect(free, 'a sustained double shock left the player zero actionable ticks').toBeGreaterThan(0)
    // The immobilize guard promises far more than "nonzero": diminishing returns
    // (30 → 15 → 7 → …) means the victim's locked share collapses over a hot chain.
    expect(free).toBeGreaterThanOrEqual(150) // at least half the window is actionable

    // And there is a GUARANTEED unbroken run of free ticks, not just free ticks
    // scattered one at a time between re-locks.
    let best = 0
    let run = 0
    for (const im of immobilizedPerTick) {
      run = im ? 0 : run + 1
      if (run > best) best = run
    }
    expect(best).toBeGreaterThanOrEqual(IMMOBILIZE_IMMUNE_TICKS)

    // No single lock ever outlasts the base duration — the no-refresh rule.
    let longestLock = 0
    run = 0
    for (const im of immobilizedPerTick) {
      run = im ? run + 1 : 0
      if (run > longestLock) longestLock = run
    }
    expect(longestLock).toBeLessThanOrEqual(ELEMENTS.electrified.durationTicks + 1)
  })

  it('CANNOT BE LOCKED TO DEATH: under sustained shock the player can still walk out', () => {
    // The whole fairness argument in one test. The player is standing in a pool
    // being shocked every 12 ticks and is holding "north". The free ticks the
    // immobilize guard grants have to be enough to actually leave the water —
    // if they were not, symmetric conduction would be a death sentence.
    const { x, y } = findOpenRect(w, 3, 3)
    pool(w, x, y + 1, 3) // the pool is the middle row; the row above is dry, open floor
    const p = player(w, x + 1, y + 1, 200)

    const north = new Map([[0, { ...emptyInput(), moveY: -1 }]])
    for (let t = 0; t < 150; t++) {
      if (w.tick % 12 === 0) shockCell(w, x + 1, y + 1)
      tickWorld(w, north)
    }

    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed, 'the player was chain-shocked to death in the water').toBeUndefined()
    expect(waterAt(w, Math.floor(p.pos.x), Math.floor(p.pos.y))).toBe(false) // got out
    expect(p.health!.hp).toBeGreaterThan(0)

    // Out of the pool, the same shocks stop reaching them.
    const hpAfterEscape = p.health!.hp
    for (let t = 0; t < 60; t++) {
      if (w.tick % 12 === 0) shockCell(w, x + 1, y + 1)
      tickWorld(w, north)
    }
    expect(p.health!.hp).toBe(hpAfterEscape)
  })

  it('TELEGRAPHED: you are soaked and the puddle is on screen before any of this', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    pool(w, x, y, 3)
    const p = player(w, x + 1, y)

    // 1. The puddle is a real entity in the snapshot the renderer and the remote
    //    phone both draw — not an invisible property of the floor.
    const snap = buildSnapshot(w)
    const cells = snap.entities.filter((e) => e.archetype === 'water')
    expect(cells.length).toBe(3)
    expect(cells[0].kind).toBe('fire') // the ground-hazard kind, like fire and spore

    // 2. Standing in it soaks you on the very first tick, and `wet` is a status
    //    the renderer already draws (render/statusUniforms.ts → uWet, blue).
    tickWorld(w, noInput())
    expect(hasStatus(p, 'wet')).toBe(true)

    // 3. …and the soak outlasts a single shock many times over, so the warning is
    //    still on your body long after the first arc.
    expect(ELEMENTS.wet.durationTicks).toBeGreaterThan(ELEMENTS.electrified.durationTicks)
  })
})

describe('the shipped wet-body chain must not regress', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('still chains through a soaked huddle on dry ground', () => {
    const { x, y } = findOpenRect(w, 5, 1)
    const ents = [body(w, x, y), body(w, x + 1, y), body(w, x + 2, y), body(w, x + 3, y)]
    for (const e of ents) wet(w, e)
    shock(w, ents[0])
    for (const e of ents) expect(hasStatus(e, 'electrified')).toBe(true)
    for (let i = 1; i < ents.length; i++) expect(ents[i].health!.hp).toBe(100 - ELEC_DAMAGE)
  })

  it('still refuses to arc across a dry gap', () => {
    const { x, y } = findOpenRect(w, 4, 1)
    const a = body(w, x, y)
    const dry = body(w, x + 1, y)
    const far = body(w, x + 2, y)
    wet(w, a)
    wet(w, far)
    shock(w, a)
    expect(hasStatus(dry, 'electrified')).toBe(false)
    expect(hasStatus(far, 'electrified')).toBe(false)
    expect(far.health!.hp).toBe(100)
  })

  it('a dry body on dry ground is still electrified but takes no water damage', () => {
    const { x, y } = findOpenRect(w, 2, 1)
    const a = body(w, x, y)
    shock(w, a)
    expect(hasStatus(a, 'electrified')).toBe(true)
    expect(a.health!.hp).toBe(100)
  })
})

describe('a big pool stays bounded', () => {
  it('conducts corner to corner across a full-cap 24-cell pool', () => {
    const w = createWorld(1, 1)
    const { x, y } = findOpenRect(w, 6, 4)
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 6; dx++) floodCell(w, x + dx, y + dy)
    const a = body(w, x, y)
    const far = body(w, x + 5, y + 3)
    expect(w.entities.filter((e) => e.water).length).toBe(24) // the cap, exactly
    shock(w, a)
    expect(hasStatus(far, 'electrified')).toBe(true)
    expect(far.health!.hp).toBe(100 - ELEC_DAMAGE)
  })
})
