// #69 Mireclaw Alpha — the world-mutating half of the boss brain (its movement/
// targeting lives in behaviors.ts `mireclaw`). Phased on its own HP, composing
// the Sporefall systems it was built to test:
//   Phase 1 (healthy > 50%): SUMMON brood on a throttle (spore-vermin adds).
//   Phase 2 (wounded 20–50%): REGENERATE while standing in a spore cloud — UNLESS
//     the cloud is on fire / it is burning (players deny the regen with fire).
//   Phase 3 (< 20%): ENRAGE — a one-time speed burst (flee-suppression is in the
//     `enrage` consideration).
// Deterministic: HP-band thresholds, tick-counter throttles, spawn positions from
// the world RNG. No Date/Math.random.

import { BODY_RADIUS, type Entity } from '../entity'
import type { World } from '../world'
import { MIRECLAW_ENRAGE_FRAC, MIRECLAW_RETREAT_FRAC } from './behaviors'
import { fireAt } from './fire'
import { canSeeEntity } from './goals'
import { spawnNpc } from '../populate'
import { bodySpawnPoint } from '../spawnPlacement'
import { hasStatus } from './statusFx'
import { sporeAt } from './spore'
import { vlen } from '../simMath'

/** Tiles at which a live player's first unbroken sight of the Alpha counts as
 * the ENTRANCE — comfortably inside a room, so the reveal fires as the door
 * swings rather than through a corridor slit half a level away. */
export const REVEAL_RANGE = 11

/** Ticks between brood summons in phase 1 (~3s at 30tps). */
export const SUMMON_INTERVAL = 90
/** Brood adds per summon. */
export const SUMMON_COUNT = 2
/** Don't summon past this many living brood near the boss (keeps it bounded). */
export const MAX_BROOD = 8
/** Radius the boss counts its brood within / drops new adds around. */
const BROOD_RADIUS = 6
/** HP regained per regen tick while safe in the cloud. */
export const REGEN_AMOUNT = 2
/** Ticks between regen ticks. */
export const REGEN_INTERVAL = 15
/** Phase-3 speed multiplier. */
export const ENRAGE_SPEED_MULT = 1.4

const broodCount = (w: World, boss: Entity): number => {
  let n = 0
  for (const e of w.entities) {
    if (e.dead || e === boss || e.archetype !== 'sporeling') continue
    if (vlen(e.pos.x - boss.pos.x, e.pos.y - boss.pos.y) <= BROOD_RADIUS) n++
  }
  return n
}

/**
 * Is a live body already standing on this candidate spot? A PREFERENCE for brood
 * placement, not a veto — see `bodySpawnPoint`. Props and movers both count
 * (a sporeling budding out of a crate is exactly what this fix is about);
 * projectiles and corpses do not, because they are not bodies you can bump into.
 */
const bodyAt = (w: World, x: number, y: number): boolean => {
  for (const e of w.entities) {
    if (e.dead || e.projectile) continue
    const rr = e.radius + BODY_RADIUS
    const dx = e.pos.x - x
    const dy = e.pos.y - y
    if (dx * dx + dy * dy < rr * rr) return true
  }
  return false
}

const summonBrood = (w: World, boss: Entity): void => {
  if (broodCount(w, boss) >= MAX_BROOD) return
  for (let i = 0; i < SUMMON_COUNT; i++) {
    // DETERMINISM: these two draws are unchanged in count, order and meaning —
    // still exactly `w.rng.next()` twice per add, at the same point in the tick.
    // `w.rng` is the whole sim's stream, so consuming one extra value here would
    // re-roll every loot drop, patrol and weapon roll for the rest of the run and
    // break replay (debug/record.ts). Everything below is a PURE function of the
    // two values already drawn plus world state that a replay reproduces
    // identically, so the stream stays byte-for-byte the same.
    const ang = w.rng.next() * Math.PI * 2
    const r = 1.5 + w.rng.next() * 2
    const x = boss.pos.x + Math.cos(ang) * r
    const y = boss.pos.y + Math.sin(ang) * r
    // The drawn point is an INTENT, not a position: a polar offset around the
    // boss lands in whatever happens to be there, and 23.7% of the time that was
    // a solid tile — where `canStand` then refuses every step out, so the add was
    // entombed for the rest of the floor and never reached anyone. Resolve the
    // intent to somewhere a body genuinely fits, preferring an unoccupied spot so
    // adds stop budding out of crates, shelves and each other (36.5% did).
    // Nothing fits at all -> the boss's own footprint, which fits by construction
    // because the boss is standing in it.
    const at = bodySpawnPoint(w.level, x, y, BODY_RADIUS, (px, py) => bodyAt(w, px, py)) ?? boss.pos
    const add = spawnNpc(w, 'sporeling', at.x, at.y)
    add.ai!.mode = 'aggro'
  }
  w.events.push({ type: 'aiGoal', entityId: boss.id, goal: 'summon', prev: boss.ai?.goal ?? 'none' })
}

/** A live player who can actually SEE the boss right now, within reveal range. */
const witness = (w: World, boss: Entity): Entity | undefined => {
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead || e.playerCtl.downed) continue
    if (vlen(e.pos.x - boss.pos.x, e.pos.y - boss.pos.y) > REVEAL_RANGE) continue
    if (canSeeEntity(w, e, boss)) return e
  }
  return undefined
}

/**
 * The ENTRANCE. The first time a live player lays eyes on the Alpha, announce
 * it: one latched `bossReveal` event carrying its id and max HP, which the UI
 * turns into a name card and pins a health bar to (ui/bossModel.ts).
 *
 * Latched on `mission.bossRevealed` (once per floor, survives serialization) so
 * walking back out of the room and in again never re-fires it. Deterministic:
 * a pure read of positions + line of sight, no RNG and no wall-clock.
 */
const maybeReveal = (w: World, boss: Entity): boolean => {
  if (w.mission.bossRevealed) return true
  if (!witness(w, boss)) return false
  w.mission.bossRevealed = true
  w.events.push({ type: 'bossReveal', entityId: boss.id, x: boss.pos.x, y: boss.pos.y, maxHp: boss.health!.max })
  return true
}

/** Standing in a spore cloud that is NOT on fire (and not itself burning). */
const inSafeCloud = (w: World, boss: Entity): boolean => {
  const tx = Math.floor(boss.pos.x)
  const ty = Math.floor(boss.pos.y)
  return sporeAt(w, tx, ty) && !fireAt(w, tx, ty) && !hasStatus(boss, 'burning')
}

export const mireclawSystem = (w: World): void => {
  for (const boss of w.entities) {
    if (boss.dead || boss.ai?.behavior !== 'mireclaw' || !boss.health) continue

    // Nothing happens until the fight is WITNESSED. Previously the summon
    // throttle ran from tick 0, so the Alpha filled its 8-brood cap ~10s into
    // the floor — minutes before anyone walked in. The player then met a static
    // room of sporelings and never saw a boss summon anything. Now phase 1
    // spends its brood on screen, at the player.
    if (!maybeReveal(w, boss)) continue

    const frac = boss.health.hp / boss.health.max

    if (frac <= MIRECLAW_ENRAGE_FRAC) {
      // Phase 3 — enrage: one-time speed burst (latched).
      if (!boss.ai.enraged) {
        boss.ai.enraged = true
        boss.speed *= ENRAGE_SPEED_MULT
      }
    } else if (frac <= MIRECLAW_RETREAT_FRAC) {
      // Phase 2 — regenerate in the cloud, unless the players have set it alight.
      if (inSafeCloud(w, boss) && w.tick % REGEN_INTERVAL === 0) {
        boss.health.hp = Math.min(boss.health.max, boss.health.hp + REGEN_AMOUNT)
      }
    } else {
      // Phase 1 — pressure (via the brain) + summon brood on a throttle.
      if (w.tick >= (boss.ai.summonAt ?? 0)) {
        summonBrood(w, boss)
        boss.ai.summonAt = w.tick + SUMMON_INTERVAL
      }
    }
  }
}
