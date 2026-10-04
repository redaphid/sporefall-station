// Regression: getting back up gave no protection. A downed player whose killer
// stayed over the body stood up at 30% hp with zero iframes and was re-downed
// 37-65 ticks later, before they could act. In `normal` that burned the revive
// pool back to back and ended the run; in `casual` (endless self-revives) it
// looped forever: ~30 s downed for every ~2 s upright, with no way out.
//
// Every scenario plays out through tickWorld: a real hostile NPC downs the
// player, the real bleed-out self-revives them, and the NPC is still there.

import { describe, expect, it } from 'vitest'
import { SPAWN_GRACE_TICKS, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { Tile } from '../levelgen/level'
import { createWorld, tickWorld, type RunMode, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'

const MELEE_REACH = 2
/** A human's beat to notice they are back up after ~30 s on the bleed screen. */
const REACTION_TICKS = 45
const BLEED_CAP = 30 * 30 + 5

const arena = (mode: RunMode): World => {
  const w = createWorld(1, 1, mode, true)
  for (let y = 18; y <= 22; y++) for (let x = 4; x <= 76; x++) w.level.tiles[y * w.level.w + x] = Tile.Floor
  return w
}

const step = (w: World, cmds: Record<number, Partial<InputCmd>>): void => {
  const m = new Map<number, InputCmd>()
  for (const [id, c] of Object.entries(cmds)) m.set(Number(id), { ...emptyInput(), ...c })
  tickWorld(w, m)
}

const dist = (a: Entity, b: Entity): number => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)

/** Let `npc` down a passive solo player, then bleed out to the self-revive with
 * the NPC still over the body. Returns at the tick the player stands back up. */
const downedThenSelfRevived = (mode: RunMode, archetype: string): { w: World; p: Entity; npc: Entity } => {
  const w = arena(mode)
  const p = spawnPlayer(w, 0, 40.5, 20.5)
  p.health!.iframes = 0
  const npc = spawnNpc(w, archetype, 41.5, 20.5)
  w.alarm = 900
  for (let t = 0; t < 600 && !p.playerCtl!.downed; t++) step(w, { 0: {} })
  expect(p.playerCtl!.downed, `${archetype} downs a passive player`).toBeDefined()
  for (let t = 0; t < BLEED_CAP && p.playerCtl!.downed; t++) step(w, { 0: {} })
  expect(p.playerCtl!.downed, 'self-revived after the bleed-out').toBeUndefined()
  expect(p.dead).toBeFalsy()
  expect(dist(p, npc), 'the attacker is still standing over the body').toBeLessThan(5)
  return { w, p, npc }
}

/** Ticks until the player is downed again (or `cap`). */
const ticksUntilDowned = (w: World, p: Entity, cmd: Partial<InputCmd>, cap: number): number => {
  for (let t = 1; t <= cap; t++) {
    step(w, { 0: cmd })
    if (p.playerCtl!.downed || p.dead) return t
  }
  return cap
}

describe('revive grace: standing back up next to the attacker', () => {
  for (const mode of ['normal', 'casual'] as const) {
    for (const archetype of ['thug', 'gangster', 'cop']) {
      it(`${mode} / ${archetype}: an idle player is untouchable for the whole grace window`, () => {
        const { w, p } = downedThenSelfRevived(mode, archetype)
        let hp = p.health!.hp
        for (let t = 0; t < SPAWN_GRACE_TICKS - 1; t++) {
          step(w, { 0: {} })
          expect(p.health!.hp, `hit ${t + 1} ticks after getting up`).toBeGreaterThanOrEqual(hp)
          hp = p.health!.hp
        }
        expect(p.playerCtl!.downed).toBeUndefined()
      })

      it(`${mode} / ${archetype}: a player who takes a second to react can still run clear`, () => {
        const { w, p, npc } = downedThenSelfRevived(mode, archetype)
        const hp = p.health!.hp
        expect(ticksUntilDowned(w, p, {}, REACTION_TICKS), 'still up when they react').toBe(REACTION_TICKS)
        expect(ticksUntilDowned(w, p, { moveX: -1 }, SPAWN_GRACE_TICKS - REACTION_TICKS)).toBe(SPAWN_GRACE_TICKS - REACTION_TICKS)
        expect(p.health!.hp, 'untouched while reacting and getting away').toBeGreaterThanOrEqual(hp)
        expect(dist(p, npc), 'opened ground on the attacker').toBeGreaterThan(MELEE_REACH)
      })
    }
  }

  it('casual: the down/up loop is broken: a fleeing player is not downed again for many seconds', () => {
    const { w, p } = downedThenSelfRevived('casual', 'thug')
    const hp = p.health!.hp
    expect(ticksUntilDowned(w, p, {}, REACTION_TICKS)).toBe(REACTION_TICKS)
    expect(ticksUntilDowned(w, p, { moveX: -1 }, 300)).toBe(300)
    expect(p.health!.hp, 'escaped with the hp they got up with').toBeGreaterThanOrEqual(hp)
  })

  it('grace wears off: an idle player next to the attacker is downed again after it', () => {
    const { w, p } = downedThenSelfRevived('casual', 'thug')
    const t = ticksUntilDowned(w, p, {}, 600)
    expect(t).toBeGreaterThanOrEqual(SPAWN_GRACE_TICKS)
    expect(t).toBeLessThan(600)
  })

  it('co-op: a teammate revive grants the same grace', () => {
    const w = arena('normal')
    const p = spawnPlayer(w, 0, 40.5, 20.5)
    const mate = spawnPlayer(w, 1, 40.5, 21.3)
    p.health!.iframes = 0
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    for (let t = 0; t < 200 && p.playerCtl!.downed; t++) step(w, { 0: {}, 1: {} })
    expect(p.playerCtl!.downed, 'teammate hauled them up').toBeUndefined()
    expect(mate.playerCtl!.downed).toBeUndefined()
    expect(p.health!.iframes).toBeGreaterThanOrEqual(SPAWN_GRACE_TICKS - 1)
  })
})
