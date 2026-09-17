// §4.3 THE SEALKEEPER — the boss that fights the architecture.
//
// PLAYER VERB: DEMOLISH. Keep your lanes open, and blow open the ones it closed.
//
// It does not want to kill you. It wants the wing sealed, and you are inside it.
// So it barely engages: it retreats, SHUTS AND RE-LOCKS doors behind it, plugs
// the chokepoints with barricades, and finally kills the wing's grid. Chase it
// and you get sealed in a dead room with whatever the outage just woke. The
// answer is that your grenades stop being a weapon and become a TOOL —
// `combat.detonate` already breaches every door in its radius, so the
// counterplay shipped years before the threat did.
//
// It is the only fight where STANDING STILL AND SHOOTING IS A LOSS CONDITION,
// and the only one that makes the level layout a combatant.
//
// ── Why everything here is entity-based ────────────────────────────────────
// The sim NEVER mutates tiles: the level is regenerable from seed+floor and
// `deserializeWorld` THROWS on a `levelChecksum` mismatch. So a boss cannot
// reshape terrain, and there are exactly two legal ways to block space — doors
// (a closed door's tile IS solid) and barricades (deliberately never solid, so
// BFS reachability survives by construction). This file uses both and invents
// no third.
//
// ── THE SAFETY CASE, which is the reason this file is worth reviewing ───────
// `movementSystem` treats a closed door's tile as fully solid, and
// `moveAndCollide` only ever commits a position whose whole circle FITS. A body
// caught inside that tile therefore fails the fit test in EVERY direction —
// permanently immobile, with no input able to free it. One press of E in your
// own doorway was once enough to brick a character, which is why the PLAYER path
// refuses to shut a door on a body and emits `doorBlocked` instead.
//
// An NPC that skips that check entombs players just as permanently. So this file
// does not re-derive the test: it imports the very predicate the player path
// uses (`interaction.doorwayOccupant`) and refuses on the same terms, with the
// same event. Sharing it is what stops the two paths drifting apart.
//
// ── THE SOFTLOCK RULE: every seal leaves a breach path ─────────────────────
// The real hazard is not death, it is a party sealed in with no grenades and no
// pickable door. Three things hold the line, and all three are asserted in
// sealkeeper.test.ts against an EMPTY inventory rather than a full one:
//
//   1. It only ever seals a PLAIN door. A hatch carrying a `sealKind` (keycard /
//      power biolock) or `overgrown` growth is refused outright — re-locking one
//      of those could demand a keycard the party no longer has, or a generator
//      across the map, which is exactly the dead end `applyAccessGate` was
//      written to make impossible.
//   2. The lock it applies is MUNDANE and pickable: `SEAL_LOCK_LEVEL` clamps
//      into `PICK_TICKS_BY_LEVEL`, so a player with nothing at all opens it by
//      standing still for a bounded number of ticks.
//   3. Barricades come from the shipped `fortify` consideration, and a barricade
//      is never solid — so no arrangement of them can cut the map in two.
//
// DETERMINISM: every input is world STATE (door flags, positions, hp, the tick
// counter). No RNG is drawn at all, so this boss consumes ZERO values from any
// existing stream and cannot move a frozen level checksum. No Date, no
// Math.random.

import { buildingAt } from '../levelgen/level'
import type { Entity } from '../entity'
import type { Vec2 } from '../types'
import type { World } from '../world'
import { maybeRevealBoss } from './bossReveal'
import { doorwayOccupant } from './interaction'
import { cutPower } from './objects'
import { vlen } from '../simMath'

/** How close it must be to a doorway to slam it. Comfortably past
 * `SEAL_STANDOFF` so the body it steered to actually completes the act. */
export const SEAL_REACH = 2

/**
 * Where it STANDS to shut a door: this far from the door's centre, on the far
 * side from the party.
 *
 * Sized against `BODY_RADIUS` (0.35) and the steering layer's 0.4 arrival
 * slop, because the failure here is silent and total: a Sealkeeper whose own
 * circle clips the door tile counts as its own `doorwayOccupant` and refuses,
 * forever, to shut the door it just walked through. 1.5 leaves it clear even
 * after arriving 0.4 short.
 */
export const SEAL_STANDOFF = 1.5

/** Ticks between seals (~1.5s). Without a throttle it would slam every door it
 * brushed past on a single tick, which reads as a bug rather than a boss. */
export const SEAL_INTERVAL = 45

/** Ticks before it re-tries a doorway it refused because someone was standing
 * in it. Short — the moment you step clear, it shuts — but not every tick, so a
 * player loitering in a frame does not spam `doorBlocked` 30 times a second. */
export const SEAL_RETRY = 10

/** How far it will walk to find a doorway worth sealing. */
export const SEAL_SEEK_RANGE = 9

/**
 * The lock level it re-locks a door to. MUST stay inside `PICK_TICKS_BY_LEVEL`
 * (L2 = 105 ticks = 3.5s), because this single number is the difference between
 * "the boss cost you time" and "the boss ended the run". See the softlock rule
 * in this file's header.
 */
export const SEAL_LOCK_LEVEL = 2

/** HP fraction at which it kills the wing's grid — matches the `GRID CUT` band
 * in its phase table (data/bosses.ts), so the HUD and the sim agree. */
export const SEALKEEPER_GRID_FRAC = 0.5

/**
 * Is this door one the Sealkeeper may shut? THE SOFTLOCK GATE (see header).
 *
 * Exported because `behaviors.sealLane` must steer by exactly the same rule it
 * acts by — a boss that walked to doors it then refused to touch would stand in
 * corridors doing nothing, and the bug would look like broken pathing.
 */
export const isSealable = (d: Entity): boolean => {
  const door = d.door
  if (!door || d.dead) return false
  if (!door.open) return false // already shut — nothing to seal
  // A biolock or a bog-grown hatch is REFUSED. Re-locking one could demand a
  // keycard the party spent or a generator on the far side of the wing, which
  // is the dead end applyAccessGate exists to prevent. Plain doors only.
  if (door.overgrown === true || door.sealKind !== undefined) return false
  return true
}

/**
 * The spot to stand on to shut door `d` while the party is at `from`: one
 * stand-off along the door's dominant ORTHO axis, on the far side from them.
 *
 * Snapped to an axis rather than taken as a raw diagonal on purpose. A diagonal
 * stand-off of the same length projects to only 0.707 of it per axis, which
 * leaves the body's circle still clipping the door tile — and a Sealkeeper that
 * clips its own doorway is its own `doorwayOccupant` and can never seal.
 * Doors sit in walls, so the passable axis IS the one the party approaches
 * along, which is the axis this picks.
 */
export const sealStandoff = (d: Entity, from: Vec2): Vec2 => {
  const dx = d.pos.x - from.x
  const dy = d.pos.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: d.pos.x + (dx < 0 ? -SEAL_STANDOFF : SEAL_STANDOFF), y: d.pos.y }
  }
  return { x: d.pos.x, y: d.pos.y + (dy < 0 ? -SEAL_STANDOFF : SEAL_STANDOFF) }
}

/**
 * Adopt the wing it stands in as its turf.
 *
 * This is what makes the SHIPPED `fortify` consideration work for a boss.
 * `fortify` finds its building through `ai.zone`, which `populate` stamps on
 * the crew it places — but the boss is spawned directly by
 * `missions.spawnFloorBoss` → `spawnNpc`, which stamps nothing. Without this the
 * Sealkeeper could never lay a single barricade, and the failure would be
 * invisible: the consideration would simply return no candidates forever.
 *
 * Claimed once, on reveal, and never re-claimed — so it keeps fortifying the
 * room it was met in even if the fight spills out into the corridor.
 */
const claimWing = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  if (ai.zone) return
  const bi = buildingAt(w.level, boss.pos.x, boss.pos.y)
  if (bi < 0) return
  ai.zone = { building: bi, role: w.level.buildings[bi].role }
}

/** The nearest door within arm's reach that it is allowed to shut. */
const doorInReach = (w: World, boss: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = SEAL_REACH
  for (const d of w.entities) {
    if (!isSealable(d)) continue
    const dist = vlen(d.pos.x - boss.pos.x, d.pos.y - boss.pos.y)
    if (dist > bestD) continue
    bestD = dist
    best = d
  }
  return best
}

/**
 * Shut and re-lock one doorway, if it is standing at one and the throttle has
 * come round — and REFUSE if a body is in the frame.
 */
const maybeSeal = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  if (w.tick < (ai.sealAt ?? 0)) return
  const target = doorInReach(w, boss)
  if (!target) return

  // ── THE SAFETY CASE ──────────────────────────────────────────────────────
  // A door must never shut on a body standing in the doorway: that body then
  // fails moveAndCollide's fit test in every direction and is immobile for the
  // rest of the run. The player path has refused this since the door-stuck bug;
  // the NPC path refuses on the SAME predicate and emits the SAME event, so the
  // UI already knows how to explain it and the two can never drift.
  const blocker = doorwayOccupant(w, target)
  if (blocker) {
    w.events.push({ type: 'doorBlocked', entityId: target.id, byId: blocker.id })
    ai.sealAt = w.tick + SEAL_RETRY // step clear and it shuts; don't spam meanwhile
    return
  }

  const door = target.door!
  door.open = false
  door.locked = true
  // ALWAYS a mundane, pickable lock — never a biolock, never off the pick table.
  // This one assignment is the softlock defence: a party with an EMPTY inventory
  // opens it by standing still for pickTicks(2) = 105 ticks.
  door.lockLevel = SEAL_LOCK_LEVEL
  ai.sealed = (ai.sealed ?? 0) + 1
  ai.sealAt = w.tick + SEAL_INTERVAL
  // Reuses the shipped `doorToggle` rather than minting a new event type: it
  // already reaches BLE clients as JSON pass-through and already has consumers.
  // New wire surface for a door closing would buy nothing.
  w.events.push({ type: 'doorToggle', entityId: target.id, open: false })
}

/**
 * Kill the wing's grid, once, when it is wounded past `SEALKEEPER_GRID_FRAC`.
 *
 * Routed through the shipped `objects.cutPower`, which takes any agent id and
 * assumes nothing about players. It is a genuinely TWO-WAY lever and that is the
 * point of using it: the outage maxes the alarm, wakes every sleeper in the
 * wing and turns the Derelict Units hostile — while simultaneously popping open
 * any `'power'` biolock on that wing (`interaction.sealSystem`). The Sealkeeper
 * is trading one of its own locks for a wing full of awake things.
 */
const maybeCutGrid = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  if (ai.gridCut) return
  if (boss.health!.hp > boss.health!.max * SEALKEEPER_GRID_FRAC) return
  const z = ai.zone
  if (!z) return
  ai.gridCut = true // latch FIRST, so a wing already dark is not cut twice
  const wing = `wing${z.building}`
  if (w.powerCut[wing] === true) return
  cutPower(w, wing, boss.id)
}

// ── Feedback: the seals have to be legible or the loss feels arbitrary ──────
// The annotation layer is explicitly INERT to the sim (no system reads it) and
// needs no new render code, so it is the honest channel — the same one the Vigil
// uses for its noise meter. The boss HUD's phase label is the other, but it
// reads off hp, and for this boss hp is not the interesting number: the count of
// doors between you and the way out is.
const ANNOTATION_PREFIX = 'sealkeeper:'

const meterText = (boss: Entity): string => {
  const sealed = boss.ai!.sealed ?? 0
  const head = boss.ai!.gridCut ? 'GRID CUT' : 'SEALING'
  return `${head} · ${sealed} SEALED — BLOW THE DOORS`
}

/** Keep one label pinned to this Sealkeeper, rewritten only when the text
 * changes so the annotation list is not churned every tick. */
const annotate = (w: World, boss: Entity): void => {
  const id = `${ANNOTATION_PREFIX}${boss.id}`
  const text = meterText(boss)
  const existing = w.annotations.find((a) => a.id === id)
  if (existing) {
    if (existing.text !== text) existing.text = text
    return
  }
  w.annotations.push({ id, kind: 'label', targetId: boss.id, text })
}

const clearMeter = (w: World, bossId: number): void => {
  const id = `${ANNOTATION_PREFIX}${bossId}`
  const i = w.annotations.findIndex((a) => a.id === id)
  if (i >= 0) w.annotations.splice(i, 1)
}

export const sealkeeperSystem = (w: World): void => {
  for (const boss of w.entities) {
    if (boss.ai?.behavior !== 'sealkeeper' || !boss.health) continue
    if (boss.dead) {
      clearMeter(w, boss.id) // the corpse takes its meter with it
      continue
    }
    // Nothing runs until the fight is WITNESSED. The Mireclaw once spent its
    // whole brood cap before anyone opened the door; a Sealkeeper left to run
    // from tick 0 would have the wing shut and the grid dark before the party
    // arrived, turning its entrance into a locked corridor with no boss in it.
    // See systems/bossReveal.ts.
    if (!maybeRevealBoss(w, boss)) continue
    claimWing(w, boss)
    maybeSeal(w, boss)
    maybeCutGrid(w, boss)
    annotate(w, boss)
  }
}
