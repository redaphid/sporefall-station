// A wet player in front of an NPC stun gunner must be in danger, not in a
// stun-lock (#99 + #92, measured by integration PR #122). The anti-chain-lock
// already bounds how long a shock HOLDS a player; these tests hold the arc's
// electrocution damage to the same window: a player takes it only when a shock
// lands a fresh lock, never while locked or in the immunity gap after.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { npcLoadout, spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { expectWorldEqual, runTicks } from '../testkit'
import { createWorld, type World } from '../world'
import { shock } from './interactions'
import { addStatus, applyStatus, IMMOBILIZE_IMMUNE_TICKS, isImmobilized } from './statusFx'

const ELEC = 20
const STUN = 45
const CADENCE = 24

const carve = (w: World, x0: number, y0: number, x1: number, y1: number, tile: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = tile
      w.level.solid[y * w.level.w + x] = tile === Tile.Wall ? 1 : 0
    }
}

/** A sealed 25x13 room: nothing but what each test puts in it. */
const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1, 'normal', true)
  w.entities = []
  w.byId.clear()
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  carve(w, 0, 0, w.level.w - 1, w.level.h - 1, Tile.Wall)
  carve(w, cx - 12, cy - 6, cx + 12, cy + 6, Tile.Floor)
  return { w, cx, cy }
}

/** Wet for the whole test, as if wading in a flood that never ebbs. */
const soak = (w: World, e: Entity): Entity => {
  addStatus(w, e, 'wet', 100000)
  return e
}

const wetPlayer = (w: World, slot: number, x: number, y: number): Entity => {
  const p = soak(w, spawnPlayer(w, slot, x, y))
  p.health = { hp: 1000, max: 1000, iframes: 0 }
  return p
}

/** Hit `e` with a stun at the current tick and return the hp it cost. */
const zap = (w: World, e: Entity, source?: number): number => {
  const hp = e.health!.hp
  applyStatus(w, e, 'electrified', STUN, source)
  return hp - e.health!.hp
}

const idle = new Map([[0, {}], [1, {}]])

describe('a wet player takes the arc once per lock', () => {
  it('the first stun on a wet player electrocutes and locks it', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    expect(zap(w, p)).toBe(ELEC)
    expect(isImmobilized(p)).toBe(true)
    expect(w.events.filter((e) => e.type === 'shock' && e.targetId === p.id)).toHaveLength(1)
  })

  it('a stun gunner firing into the lock deals no electrocution and emits no shock hit', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    zap(w, p)
    runTicks(w, idle, CADENCE)
    expect(isImmobilized(p)).toBe(true)
    w.events = []
    expect(zap(w, p)).toBe(0)
    expect(w.events.some((e) => e.type === 'shock' && e.targetId === p.id)).toBe(false)
  })

  it('nor in the immunity gap after the lock, but the next legal hit bites again', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    zap(w, p)
    runTicks(w, idle, STUN + 1)
    expect(isImmobilized(p)).toBe(false)
    expect(zap(w, p)).toBe(0)
    runTicks(w, idle, IMMOBILIZE_IMMUNE_TICKS)
    expect(zap(w, p)).toBe(ELEC)
    expect(isImmobilized(p)).toBe(true)
  })

  it('a frozen wet player is not electrocuted: every control shares the one guard', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    addStatus(w, p, 'frozen', 120)
    expect(zap(w, p)).toBe(0)
  })

  it('a wet player knocked flat by a legacy stun (sledgehammer, slip) is not electrocuted', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    applyStatus(w, p, 'stun', 20)
    expect(zap(w, p)).toBe(0)
  })

  it('a dead or downed player is left alone, as before', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    p.playerCtl!.downed = { bleedTicks: 300, reviveProgress: 0 }
    expect(zap(w, p)).toBe(0)
  })
})

describe('the wet teammate', () => {
  it('the arc floods a wet teammate one tile off once per lock, not on every hit to the victim', () => {
    const { w, cx, cy } = arena()
    const a = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    const b = wetPlayer(w, 1, cx + 0.5, cy + 1.5)
    const cost = (): number => {
      const before = b.health!.hp
      zap(w, a)
      return before - b.health!.hp
    }
    expect(cost()).toBe(ELEC)
    expect(isImmobilized(b)).toBe(true)
    const hits: number[] = []
    for (let i = 0; i < 3; i++) {
      runTicks(w, idle, CADENCE)
      hits.push(cost())
    }
    // 24 and 48 land inside b's lock and gap (45 + 18 ticks); 72 is past it.
    expect(hits).toEqual([0, 0, ELEC])
  })

  it('the guard is per body: a teammate who was dry for the first arc is hurt by the next', () => {
    const { w, cx, cy } = arena()
    const a = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    const b = spawnPlayer(w, 1, cx + 0.5, cy + 1.5)
    b.health = { hp: 1000, max: 1000, iframes: 0 }
    zap(w, a)
    expect(b.health.hp).toBe(1000)
    soak(w, b)
    runTicks(w, idle, CADENCE)
    zap(w, a)
    expect(b.health.hp).toBe(1000 - ELEC)
  })
})

describe('NPCs keep the full flood (the player\'s Tesla against wet enemies)', () => {
  it('a wet thug shocked again inside its lock still takes the electrocution', () => {
    const { w, cx, cy } = arena()
    const thug = soak(w, spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    thug.health = { hp: 1000, max: 1000, iframes: 0 }
    shock(w, thug)
    w.tick += CADENCE
    expect(isImmobilized(thug)).toBe(true)
    shock(w, thug)
    expect(thug.health.hp).toBe(1000 - 2 * ELEC)
  })

  it('a wet player\'s shock on a wet thug beside it floods the thug every time, and the player once', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx + 0.5, cy + 0.5)
    const thug = soak(w, spawnNpc(w, 'thug', cx + 1.5, cy + 0.5))
    thug.health = { hp: 1000, max: 1000, iframes: 0 }
    shock(w, thug, STUN, p.id)
    w.tick += CADENCE
    shock(w, thug, STUN, p.id)
    expect(thug.health.hp).toBe(1000 - 2 * ELEC)
    expect(p.health!.hp).toBe(1000 - ELEC)
  })
})

describe('the real stun gun on a wet player', () => {
  const stunGunner = (w: World, x: number, y: number): Entity => {
    const gunner = spawnNpc(w, 'gangster', x, y)
    gunner.health = { hp: 100000, max: 100000, iframes: 0 }
    gunner.combat!.weapon = 'stunGun'
    gunner.loadout = npcLoadout('stunGun')
    return gunner
  }

  it('over 10 s the player never takes electrocution on a tick it could not act', () => {
    const { w, cx, cy } = arena()
    const p = wetPlayer(w, 0, cx - 2 + 0.5, cy + 0.5)
    stunGunner(w, cx + 2 + 0.5, cy + 0.5)
    let hits = 0
    for (let t = 0; t < 300; t++) {
      const locked = isImmobilized(p)
      runTicks(w, idle, 1)
      const arcs = w.events.filter((e) => e.type === 'shock' && e.targetId === p.id).length
      hits += arcs
      if (locked) expect(arcs, `tick ${t}`).toBe(0)
    }
    expect(hits).toBeGreaterThanOrEqual(3)
  })

  it('a mid-lock snapshot replays the guarded arcs byte-identically', () => {
    const w = createWorld(5, 1, 'normal', true)
    const at = playerSpawnPoint(w.level, 0)
    const p = wetPlayer(w, 0, at.x, at.y)
    stunGunner(w, at.x + 1, at.y)
    while (!isImmobilized(p)) runTicks(w, idle, 1)
    runTicks(w, idle, 5)
    const a = deserializeWorld(serializeWorld(w))
    const b = deserializeWorld(serializeWorld(w))
    runTicks(a, idle, 120)
    runTicks(b, idle, 120)
    expectWorldEqual(a, b)
    runTicks(w, idle, 120)
    expectWorldEqual(w, a)
  })
})
