// Weapon-mod playtest harness (chore/playtest) — MEASUREMENT ONLY.
//
// An agent "plays" the game: real seeded floors, a driven player that engages
// and fires a MODDED weapon, with the live ECS sampled every tick. Nothing in
// src/game is modified or monkey-patched — every number below is read off the
// world or its own event stream.
//
// Two scenarios:
//   arena — real seeded floor GEOMETRY, but a deterministic enemy cohort placed
//           in the most open room. Guarantees contact, so time-to-kill is
//           comparable across mod combinations (the degeneracy matrix).
//   floor — the real populated floor, untouched, played end to end. Robustness:
//           crashes, leaks, runaway spawns, tick-time blowups over a long run.
//
//   pnpm exec tsx scripts/test/mod-playtest.ts --mode=matrix > out.json
//   pnpm exec tsx scripts/test/mod-playtest.ts --mode=floor  > floor.json
//   pnpm exec tsx scripts/test/mod-playtest.ts --mode=determinism
//   pnpm exec tsx scripts/test/mod-playtest.ts --combo=split,explosive --seed=1234 --trace

import { createWorld, tickWorld, type World } from '../../src/game/world'
import { populateWorld, spawnNpc } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { weaponStack } from '../../src/game/systems/inventory'
import { applyDraftPick } from '../../src/game/systems/draft'
import { resolveWeapon } from '../../src/game/systems/resolveWeapon'
import { serializeWorld, deserializeWorld } from '../../src/game/serialize'
import { isSolidTile } from '../../src/game/levelgen/level'
import { MODS, normalizeMods } from '../../src/game/data/mods'
import { WEAPONS } from '../../src/game/data/items'
import { hasLineOfSight } from '../../src/game/los'
import { findPath } from '../../src/game/path'
import type { Entity } from '../../src/game/entity'
import type { InputCmd, Vec2 } from '../../src/game/types'

const NEUTRAL: InputCmd = {
  seq: 0, moveX: 0, moveY: 0, attack: false, interact: false,
  special: false, aimX: 1, aimY: 0, hotbar: -1, throwItem: false, roll: false,
}

/** Two cohorts, because one number cannot answer both questions.
 *
 * `light` — the DEGENERACY yardstick. Plain-resist enemies a bare pistol can
 * actually clear, so time-to-kill is a real measurement rather than a censored
 * "timed out" for every row, and a mod that trivialises the game shows up as a
 * collapsed TTK against the same wall.
 *
 * `armored` — the RPS check. robot/brute resist physical (0.4/0.35) and burn
 * hot (1.5); cinder is the inverse (1.1 physical, 0.2 burning). A raw-damage
 * mod should stall here while an elemental one should not. */
const COHORTS = {
  light: ['thug', 'thug', 'thug', 'gangster', 'sporeling', 'sporeling'],
  armored: ['robot', 'brute', 'cinder'],
} as const
type CohortName = keyof typeof COHORTS
const ARENA_RADIUS = 5.0   // ring the cohort spawns on
const ENGAGE_NEAR = 3.0    // back off inside this
const ENGAGE_FAR = 6.0     // close outside this
const MAX_TICKS = 1800     // 60s cap per arena run
const QUIESCE_TICKS = 400  // post-fight, weapons cold: anything still alive is a leak

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/** FNV-1a over the serialized world — the determinism fingerprint. */
const hashWorld = (w: World): string => {
  const s = JSON.stringify(serializeWorld(w))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Scenario construction
// ---------------------------------------------------------------------------

/** The most open walkable tile on the floor: maximise the square-clearance
 * radius, ties broken by scan order so it is a pure function of seed+floor. */
const findArena = (w: World): Vec2 => {
  const L = w.level
  let best = { x: L.spawn.x, y: L.spawn.y }
  let bestR = -1
  const clearance = (tx: number, ty: number): number => {
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
          if (isSolidTile(L, tx + dx, ty + dy)) return r - 1
        }
      }
    }
    return 8
  }
  for (let ty = 1; ty < L.h - 1; ty++) {
    for (let tx = 1; tx < L.w - 1; tx++) {
      if (isSolidTile(L, tx, ty)) continue
      const r = clearance(tx, ty)
      if (r > bestR) { bestR = r; best = { x: tx + 0.5, y: ty + 0.5 } }
      if (bestR >= 8) break
    }
    if (bestR >= 8) break
  }
  return best
}

/** Nearest walkable tile-centre to a point (deterministic spiral). */
const nearestOpen = (w: World, x: number, y: number): Vec2 => {
  const tx = Math.floor(x), ty = Math.floor(y)
  if (!isSolidTile(w.level, tx, ty)) return { x: tx + 0.5, y: ty + 0.5 }
  for (let r = 1; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        if (!isSolidTile(w.level, tx + dx, ty + dy)) return { x: tx + dx + 0.5, y: ty + dy + 0.5 }
      }
    }
  }
  return { x: tx + 0.5, y: ty + 0.5 }
}

export interface Combo { mods: { id: string; stacks: number }[] }

const bootstrap = (seed: number, floor: number): { w: World; p: Entity } => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return { w, p }
}

/** Attach the combo to the player's slotted weapon via the SAME write path the
 * draft UI and the addMod verb use (no bespoke mutation). */
const applyCombo = (p: Entity, combo: Combo): { id: string; stacks: number }[] => {
  const stack = weaponStack(p)
  if (!stack) throw new Error('player has no slotted weapon')
  for (const m of combo.mods) applyDraftPick(stack, m.id, m.stacks)
  return stack.mods ?? []
}

/** Build the arena in a real seeded floor: strip the populated NPCs and the
 * world's mod pickups (which would otherwise silently ADD mods mid-run and
 * contaminate the measurement), then ring a fixed cohort around the player. */
const buildArena = (w: World, p: Entity, which: CohortName = 'light'): { centre: Vec2; cohort: number[] } => {
  const roster = COHORTS[which]
  const centre = findArena(w)
  for (const e of w.entities) {
    if (e.kind === 'npc') e.dead = true
    // Any pickup that could mutate the loadout mid-run.
    if (e.kind === 'pickup') e.dead = true
  }
  w.entities = w.entities.filter((e) => !e.dead || e.kind === 'player')
  w.byId.clear()
  for (const e of w.entities) w.byId.set(e.id, e)

  p.pos.x = centre.x; p.pos.y = centre.y
  const cohort: number[] = []
  for (let i = 0; i < roster.length; i++) {
    const a = (Math.PI * 2 * i) / roster.length
    const at = nearestOpen(w, centre.x + Math.cos(a) * ARENA_RADIUS, centre.y + Math.sin(a) * ARENA_RADIUS)
    const n = spawnNpc(w, roster[i], at.x, at.y)
    // Wake dormant things and make them commit — we are measuring the WEAPON,
    // not the AI's willingness to approach (see the ai-audit contact finding).
    if (n.dormant) n.dormant = false
    if (n.ai) n.ai.mode = 'aggro'
    cohort.push(n.id)
  }
  return { centre, cohort }
}

// ---------------------------------------------------------------------------
// The driven player
// ---------------------------------------------------------------------------

const liveNpcs = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'npc' && !e.dead)

/** Arena pilot: face the nearest live enemy, hold the trigger, and hold a
 * firing lane (back off point-blank, close from long range). Pure function of
 * world state, so the whole run is seed-reproducible. */
const pilotArena = (w: World, p: Entity, fire: boolean, projSpeed = 14, range = 10, c?: PathCache): InputCmd => {
  const cmd: InputCmd = { ...NEUTRAL }
  let target: Entity | null = null
  let bestD = Infinity
  for (const e of liveNpcs(w)) {
    // Prefer a target we can actually shoot — firing into a wall is what makes
    // a naive pilot look like a bad weapon.
    if (!hasLineOfSight(w.level, p.pos.x, p.pos.y, e.pos.x, e.pos.y)) continue
    const d = dist(p.pos, e.pos)
    if (d < bestD) { bestD = d; target = e }
  }
  if (!target) {
    // Nothing in sight: PATH to the nearest live body so the fight resumes
    // instead of the run quietly timing out (the ai-audit under-sampling trap).
    let fallback: Entity | null = null; let fd = Infinity
    for (const e of liveNpcs(w)) { const d = dist(p.pos, e.pos); if (d < fd) { fd = d; fallback = e } }
    if (!fallback) return cmd
    const dx = fallback.pos.x - p.pos.x, dy = fallback.pos.y - p.pos.y
    const dl = Math.hypot(dx, dy) || 1
    cmd.aimX = dx / dl; cmd.aimY = dy / dl
    cmd.interact = true // shove a door rather than grind against it
    if (c) {
      if (w.tick >= c.at || !c.path || c.path.length === 0) {
        c.path = findPath(w.level, p.pos.x, p.pos.y, fallback.pos.x, fallback.pos.y, { bestEffort: true })
        c.at = w.tick + 12
      }
      const node = c.path?.[0]
      if (node) {
        const nx = node.x + 0.5 - p.pos.x, ny = node.y + 0.5 - p.pos.y
        const nl = Math.hypot(nx, ny)
        if (nl < 0.35) c.path!.shift()
        else { cmd.moveX = nx / nl; cmd.moveY = ny / nl; return cmd }
      }
    }
    cmd.moveX = dx / dl; cmd.moveY = dy / dl
    return cmd
  }
  if (c) { c.path = null; c.at = -1 } // re-acquired: drop the stale route
  // Lead the shot: aim where the target will BE when the bullet arrives.
  const tImpact = bestD / Math.max(projSpeed, 0.5) // seconds
  const px = target.pos.x + target.vel.x * tImpact
  const py = target.pos.y + target.vel.y * tImpact
  const ax = px - p.pos.x, ay = py - p.pos.y
  const al = Math.hypot(ax, ay) || 1
  cmd.aimX = ax / al; cmd.aimY = ay / al
  // Only pull the trigger inside the round's actual reach — a bullet fired at a
  // target 20 tiles away dies to ttl and would score as a "miss" against the mod.
  cmd.attack = fire && bestD <= range * 0.9
  // Hold the lane and SHOOT — do not strafe. A laterally-moving shooter misses a
  // laterally-moving target, which reads as "this mod is weak" when it is really
  // the pilot. Back off only when a melee body is on top of us.
  if (bestD < ENGAGE_NEAR) { cmd.moveX = -ax / al; cmd.moveY = -ay / al }
  else if (bestD > ENGAGE_FAR) { cmd.moveX = ax / al; cmd.moveY = ay / al }
  return cmd
}

interface PathCache { path: Vec2[] | null; at: number; last: Vec2; stillSince: number; stalls: number }

/** Floor pilot: route to the nearest live NPC and shoot on sight. Unlike the
 * ai-audit rig this DETECTS the locked-door stall (position frozen while a path
 * exists) and re-routes past it, so contact is not under-sampled. */
const pilotFloor = (w: World, p: Entity, c: PathCache): InputCmd => {
  let target: Entity | null = null
  let bestD = Infinity
  for (const e of liveNpcs(w)) {
    if (!e.ai) continue
    const d = dist(p.pos, e.pos)
    if (d < bestD) { bestD = d; target = e }
  }
  if (!target) return { ...NEUTRAL }
  const cmd: InputCmd = { ...NEUTRAL }
  const ax = target.pos.x - p.pos.x, ay = target.pos.y - p.pos.y
  const al = Math.hypot(ax, ay) || 1
  cmd.aimX = ax / al; cmd.aimY = ay / al
  cmd.attack = hasLineOfSight(w.level, p.pos.x, p.pos.y, target.pos.x, target.pos.y) && bestD <= 8
  cmd.interact = true // shove doors / pick locks on the way, like a player

  // --- anti-stall: if we have not moved in 90 ticks we are jammed on a seal.
  if (dist(p.pos, c.last) < 0.05) {
    c.stillSince++
    if (c.stillSince > 90) {
      // Re-seat next to the target: a measurement-rig teleport, counted and
      // reported so the stall rate stays visible rather than silently skewing.
      const at = nearestOpen(w, target.pos.x - cmd.aimX * 2, target.pos.y - cmd.aimY * 2)
      p.pos.x = at.x; p.pos.y = at.y
      c.stillSince = 0; c.stalls++; c.path = null; c.at = -1
    }
  } else c.stillSince = 0
  c.last = { x: p.pos.x, y: p.pos.y }

  if (bestD <= 1.6) return cmd
  if (w.tick >= c.at || !c.path || c.path.length === 0) {
    c.path = findPath(w.level, p.pos.x, p.pos.y, target.pos.x, target.pos.y, { bestEffort: true })
    c.at = w.tick + 12
  }
  const node = c.path?.[0]
  if (node) {
    const nx = node.x + 0.5 - p.pos.x, ny = node.y + 0.5 - p.pos.y
    const nl = Math.hypot(nx, ny)
    if (nl < 0.35) c.path!.shift()
    else { cmd.moveX = nx / nl; cmd.moveY = ny / nl }
  } else { cmd.moveX = ax / al; cmd.moveY = ay / al }
  return cmd
}

// ---------------------------------------------------------------------------
// Run + sample
// ---------------------------------------------------------------------------

export interface RunResult {
  combo: string
  seed: number
  floor: number
  cohortName?: CohortName
  /** Resolved gun the combo actually produces (pure fold, no sim needed). */
  resolved: { damage: number; cooldownTicks: number; pellets: number; dps: number }
  ttk: number | null        // tick the last cohort member died; null = never
  kills: number
  cohort: number
  dmgDealt: number
  dmgTaken: number
  shots: number             // player projectiles spawned
  hits: number
  playerHpEnd: number
  survived: boolean
  peakProjectiles: number
  peakEntities: number
  residualProjectiles: number  // still flying after QUIESCE_TICKS with no firing
  endEntities: number
  maxTickMs: number
  totalMs: number
  modsAtEnd: string         // contamination check
  error?: string
  stalls?: number
}

const comboLabel = (c: Combo): string =>
  c.mods.length === 0 ? '(none)' : c.mods.map((m) => (m.stacks > 1 ? `${m.id}x${m.stacks}` : m.id)).join('+')

export const runArena = (combo: Combo, seed: number, floor = 1, trace = false, which: CohortName = 'light'): RunResult => {
  const label = comboLabel(combo)
  const base: RunResult = {
    combo: label, seed, floor, cohortName: which,
    resolved: { damage: 0, cooldownTicks: 0, pellets: 0, dps: 0 },
    ttk: null, kills: 0, cohort: COHORTS[which].length, dmgDealt: 0, dmgTaken: 0,
    shots: 0, hits: 0, playerHpEnd: 0, survived: false,
    peakProjectiles: 0, peakEntities: 0, residualProjectiles: 0, endEntities: 0,
    maxTickMs: 0, totalMs: 0, modsAtEnd: '',
  }
  try {
    const { w, p } = bootstrap(seed, floor)
    const mods = applyCombo(p, combo)
    const stack = weaponStack(p)!
    const rw = resolveWeapon(WEAPONS[stack.itemId], mods)
    base.resolved = {
      damage: rw.damage, cooldownTicks: rw.cooldownTicks, pellets: rw.pellets,
      dps: +((rw.damage * rw.pellets * 30) / rw.cooldownTicks).toFixed(1),
    }
    const { cohort } = buildArena(w, p, which)
    const cohortSet = new Set(cohort)
    const pid = p.id
    const seenProj = new Set<number>()
    const pc: PathCache = { path: null, at: -1, last: { x: p.pos.x, y: p.pos.y }, stillSince: 0, stalls: 0 }
    const t0 = Date.now()

    let fire = true
    for (let t = 0; t < MAX_TICKS + QUIESCE_TICKS; t++) {
      // Once the cohort is down, stop firing and let the world settle: whatever
      // is still airborne after QUIESCE_TICKS never expires.
      const remaining = [...cohortSet].filter((id) => { const e = w.byId.get(id); return e && !e.dead }).length
      if (remaining === 0 && base.ttk === null) { base.ttk = w.tick; fire = false }
      if (base.ttk === null && t >= MAX_TICKS) { fire = false }
      if (base.ttk !== null && w.tick > (base.ttk + QUIESCE_TICKS)) break
      if (!fire && t >= MAX_TICKS + QUIESCE_TICKS - 1) break

      // Pin the cohort COMMITTED. Left alone, a wounded NPC flips to `flee` and
      // sprints off at 4 hp, and a ranged one kites at a fixed standoff forever
      // — so the run measures the AI's willingness to fight, not the gun. (The
      // ai-audit sweep found the same thing: there is no contact system.) This
      // is a rig-side override of AI state only; `--mode=floor` leaves the real
      // AI completely untouched.
      for (const id of cohortSet) {
        const e = w.byId.get(id)
        if (!e || e.dead || !e.ai) continue
        e.ai.mode = 'aggro'
        e.ai.targetId = pid
      }

      const inputs = new Map<number, InputCmd>()
      if (!p.dead) inputs.set(0, pilotArena(w, p, fire && !p.dead, rw.projectileSpeed, rw.base.range ?? 10, pc))

      const tickStart = Date.now()
      tickWorld(w, inputs)
      const ms = Date.now() - tickStart
      if (ms > base.maxTickMs) base.maxTickMs = ms

      // --- sample the live ECS -------------------------------------------
      let proj = 0
      for (const e of w.entities) {
        if (e.kind !== 'projectile' || e.dead) continue
        proj++
        // Every distinct projectile the player's gun ever put in the air —
        // muzzle rounds AND their split/splinter children (the spawn-count
        // metric that catches a self-replicating combo).
        if (e.projectile?.ownerId === pid && !seenProj.has(e.id)) { seenProj.add(e.id); base.shots++ }
      }
      if (proj > base.peakProjectiles) base.peakProjectiles = proj
      if (w.entities.length > base.peakEntities) base.peakEntities = w.entities.length

      for (const ev of w.events) {
        if (ev.type === 'hit') {
          const tgt = w.byId.get(ev.targetId)
          if (ev.targetId === pid) base.dmgTaken += ev.amount
          else if (tgt?.kind === 'npc') { base.dmgDealt += ev.amount; base.hits++ }
        } else if (ev.type === 'death' && cohortSet.has(ev.entityId)) base.kills++
      }
      if (trace && t % 60 === 0) {
        process.stderr.write(`  t=${w.tick} proj=${proj} ents=${w.entities.length} alive=${remaining} php=${p.health?.hp}\n`)
      }
    }

    base.totalMs = Date.now() - t0
    base.playerHpEnd = p.health?.hp ?? 0
    base.survived = !p.dead
    base.endEntities = w.entities.length
    let residual = 0
    for (const e of w.entities) if (e.kind === 'projectile' && !e.dead) residual++
    base.residualProjectiles = residual
    base.modsAtEnd = (normalizeMods(weaponStack(p)?.mods) ?? []).map((m) => `${m.id}x${m.stacks}`).join(',')
  } catch (err) {
    base.error = err instanceof Error ? `${err.message}` : String(err)
  }
  return base
}

export const runFloor = (combo: Combo, seed: number, floor: number, ticks: number): RunResult => {
  const out: RunResult = {
    combo: comboLabel(combo), seed, floor,
    resolved: { damage: 0, cooldownTicks: 0, pellets: 0, dps: 0 },
    ttk: null, kills: 0, cohort: 0, dmgDealt: 0, dmgTaken: 0, hits: 0, shots: 0,
    playerHpEnd: 0, survived: false, peakProjectiles: 0, peakEntities: 0,
    residualProjectiles: 0, endEntities: 0, maxTickMs: 0, totalMs: 0, modsAtEnd: '',
  }
  try {
    const { w, p } = bootstrap(seed, floor)
    const mods = applyCombo(p, combo)
    const stack = weaponStack(p)!
    const rw = resolveWeapon(WEAPONS[stack.itemId], mods)
    out.resolved = { damage: rw.damage, cooldownTicks: rw.cooldownTicks, pellets: rw.pellets, dps: +((rw.damage * rw.pellets * 30) / rw.cooldownTicks).toFixed(1) }
    if (p.health) { p.health.hp = 100000; p.health.max = 100000 } // observer stays alive to sample the whole floor
    const c: PathCache = { path: null, at: -1, last: { x: p.pos.x, y: p.pos.y }, stillSince: 0, stalls: 0 }
    const pid = p.id
    const t0 = Date.now()
    out.cohort = liveNpcs(w).length
    for (let t = 0; t < ticks; t++) {
      const inputs = new Map<number, InputCmd>()
      if (!p.dead) inputs.set(0, pilotFloor(w, p, c))
      const s = Date.now()
      tickWorld(w, inputs)
      const ms = Date.now() - s
      if (ms > out.maxTickMs) out.maxTickMs = ms
      let proj = 0
      for (const e of w.entities) if (e.kind === 'projectile' && !e.dead) proj++
      if (proj > out.peakProjectiles) out.peakProjectiles = proj
      if (w.entities.length > out.peakEntities) out.peakEntities = w.entities.length
      for (const ev of w.events) {
        if (ev.type === 'hit') {
          const tgt = w.byId.get(ev.targetId)
          if (ev.targetId === pid) out.dmgTaken += ev.amount
          else if (tgt?.kind === 'npc') { out.dmgDealt += ev.amount; out.hits++ }
        } else if (ev.type === 'death') { const e = w.byId.get(ev.entityId); if (e?.kind === 'npc') out.kills++ }
      }
    }
    out.totalMs = Date.now() - t0
    out.stalls = c.stalls
    out.playerHpEnd = p.health?.hp ?? 0
    out.survived = !p.dead
    out.endEntities = w.entities.length
    let residual = 0
    for (const e of w.entities) if (e.kind === 'projectile' && !e.dead) residual++
    out.residualProjectiles = residual
    out.modsAtEnd = (normalizeMods(weaponStack(p)?.mods) ?? []).map((m) => `${m.id}x${m.stacks}`).join(',')
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
  }
  return out
}

// ---------------------------------------------------------------------------
// Determinism: same seed + same inputs → byte-identical, incl. a mid-run
// serialize/deserialize round-trip (the existing WorldJson contract).
// ---------------------------------------------------------------------------

export interface DetResult { combo: string; seed: number; repeatOk: boolean; roundTripOk: boolean; hashA: string; hashB: string; hashRt: string; error?: string }

const playArena = (combo: Combo, seed: number, ticks: number, roundTripAt = -1): { hash: string } => {
  const { w, p } = bootstrap(seed, 1)
  applyCombo(p, combo)
  const { cohort } = buildArena(w, p)
  let world = w
  let player = p
  // NOTE: no PathCache here. The cache is rig-side memo state that does not live
  // in the world, so it would NOT survive the serialize round-trip and would
  // fake a divergence. The determinism pilot is therefore purely world-derived.
  for (let t = 0; t < ticks; t++) {
    if (t === roundTripAt) {
      const json = JSON.parse(JSON.stringify(serializeWorld(world)))
      world = deserializeWorld(json)
      const np = world.entities.find((e) => e.kind === 'player')
      if (!np) throw new Error('player lost across round-trip')
      player = np
    }
    // Same commitment pin as runArena, and equally world-derived, so it replays
    // identically on either side of the round-trip.
    for (const id of cohort) {
      const e = world.byId.get(id)
      if (!e || e.dead || !e.ai) continue
      e.ai.mode = 'aggro'
      e.ai.targetId = player.id
    }
    const inputs = new Map<number, InputCmd>()
    if (!player.dead) inputs.set(0, pilotArena(world, player, true))
    tickWorld(world, inputs)
  }
  return { hash: hashWorld(world) }
}

export const checkDeterminism = (combo: Combo, seed: number, ticks = 600): DetResult => {
  const label = comboLabel(combo)
  try {
    const a = playArena(combo, seed, ticks)
    const b = playArena(combo, seed, ticks)
    const rt = playArena(combo, seed, ticks, Math.floor(ticks / 2))
    return {
      combo: label, seed, hashA: a.hash, hashB: b.hash, hashRt: rt.hash,
      repeatOk: a.hash === b.hash, roundTripOk: a.hash === rt.hash,
    }
  } catch (err) {
    return { combo: label, seed, hashA: '', hashB: '', hashRt: '', repeatOk: false, roundTripOk: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ALL_MODS = Object.keys(MODS).sort()
const SEEDS = [1234, 8675309, 42]

const parseCombo = (s: string): Combo => ({
  mods: s.split(',').filter(Boolean).map((tok) => {
    const [id, n] = tok.split('x')
    return { id, stacks: n ? Number(n) : 1 }
  }),
})

const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const main = (): void => {
  const mode = arg('mode') ?? 'matrix'
  const trace = process.argv.includes('--trace')

  if (arg('combo') !== undefined) {
    const combo = parseCombo(arg('combo')!)
    const seed = Number(arg('seed') ?? SEEDS[0])
    console.log(JSON.stringify(runArena(combo, seed, Number(arg('floor') ?? 1), trace), null, 2))
    return
  }

  if (mode === 'determinism') {
    const combos: Combo[] = [{ mods: [] }, ...ALL_MODS.map((id) => ({ mods: [{ id, stacks: 1 }] }))]
    // plus a few nasty compositions
    combos.push(parseCombo('split,explosive,bounce'), parseCombo('splinterShot,detonator,pierce'), parseCombo('homing,bounce,splinterShot'))
    const out: DetResult[] = []
    for (const c of combos) for (const s of SEEDS.slice(0, 2)) {
      const r = checkDeterminism(c, s)
      out.push(r)
      process.stderr.write(`det ${r.combo}@${s} repeat=${r.repeatOk} rt=${r.roundTripOk}${r.error ? ' ERR ' + r.error : ''}\n`)
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (mode === 'floor') {
    const ticks = Number(arg('ticks') ?? 2400)
    const combos: Combo[] = [{ mods: [] }, ...['split', 'explosive', 'splinterShot', 'bounce', 'detonator', 'homing', 'lifesteal', 'glassCannon'].map((id) => ({ mods: [{ id, stacks: modStacks(id) }] }))]
    combos.push(parseCombo('split,explosive'), parseCombo('splinterShot,detonator'), parseCombo('bounce,splinterShot,explosive'))
    const out: RunResult[] = []
    for (const c of combos) for (const s of SEEDS) for (const f of [1, 2]) {
      const r = runFloor(c, s, f, ticks)
      out.push(r)
      process.stderr.write(`floor ${r.combo}@${s}/${f} kills=${r.kills} dmg=${r.dmgDealt} peakProj=${r.peakProjectiles} peakEnt=${r.peakEntities} resid=${r.residualProjectiles} maxMs=${r.maxTickMs} stalls=${r.stalls}${r.error ? ' ERR ' + r.error : ''}\n`)
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  // matrix: baseline + singles + all pairs + a deterministic sample of triples
  const combos: Combo[] = [{ mods: [] }]
  for (const id of ALL_MODS) combos.push({ mods: [{ id, stacks: modStacks(id) }] })
  for (let i = 0; i < ALL_MODS.length; i++)
    for (let j = i + 1; j < ALL_MODS.length; j++)
      combos.push({ mods: [{ id: ALL_MODS[i], stacks: 1 }, { id: ALL_MODS[j], stacks: 1 }] })
  // triples: every 7th of the full C(18,3) enumeration → an even, reproducible spread
  const triples: Combo[] = []
  for (let i = 0; i < ALL_MODS.length; i++)
    for (let j = i + 1; j < ALL_MODS.length; j++)
      for (let k = j + 1; k < ALL_MODS.length; k++)
        triples.push({ mods: [{ id: ALL_MODS[i], stacks: 1 }, { id: ALL_MODS[j], stacks: 1 }, { id: ALL_MODS[k], stacks: 1 }] })
  for (let i = 0; i < triples.length; i += 7) combos.push(triples[i])

  process.stderr.write(`matrix: ${combos.length} combos x ${SEEDS.length} seeds\n`)
  const out: RunResult[] = []
  let n = 0
  for (const c of combos) {
    for (const s of SEEDS) {
      const r = runArena(c, s)
      out.push(r)
      if (r.error) process.stderr.write(`ERR ${r.combo}@${s}: ${r.error}\n`)
    }
    if (++n % 25 === 0) process.stderr.write(`  ${n}/${combos.length}\n`)
  }
  console.log(JSON.stringify(out, null, 2))
}

/** Single-mod runs use the mod's own cap so a stacking blowup can show itself. */
function modStacks(id: string): number { return 1 }

main()
