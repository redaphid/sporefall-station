// Contact arena (chore/ai-audit) — MEASUREMENT ONLY.
//
// Puts ONE awake, hostile NPC of each archetype in an open room with a player
// and records, tick by tick, everything the NPC actually DOES once it is inside
// melee / firing range: its mode, its goal, how it moves relative to the player
// (closing / backing off / strafing / standing), and the cadence of the hits it
// lands. The question this answers is not "what could it do" but "how many
// distinguishable things does a player at knife range ever see".
//
//   npx tsx scripts/test/contact-arena.ts

import { createWorld, tickWorld, type World } from '../../src/game/world'
import { populateWorld, spawnNpc } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { isSolidTile } from '../../src/game/levelgen/level'
import { NPCS } from '../../src/game/data/npcs'
import { WEAPONS } from '../../src/game/data/items'
import type { Entity } from '../../src/game/entity'
import type { InputCmd } from '../../src/game/types'

const NEUTRAL: InputCmd = {
  seq: 0, moveX: 0, moveY: 0, attack: false, interact: false,
  special: false, aimX: 1, aimY: 0, hotbar: -1, throwItem: false, roll: false,
}
const TICKS = Number(process.env.ARENA_TICKS ?? 900)
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** An open tile ~`want` tiles from (cx,cy) with clear surroundings. */
const openSpotNear = (w: World, cx: number, cy: number, want: number): { x: number; y: number } | null => {
  for (let r = want; r <= want + 6; r++) {
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2
      const x = Math.round(cx + Math.cos(th) * r)
      const y = Math.round(cy + Math.sin(th) * r)
      let ok = true
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (isSolidTile(w.level, x + dx, y + dy)) { ok = false; break }
      if (ok) return { x: x + 0.5, y: y + 0.5 }
    }
  }
  return null
}

interface Row {
  archetype: string; behavior: string; ranged: boolean
  contactTicks: number
  modes: Record<string, number>
  goals: Record<string, number>
  motion: Record<string, number>      // at contact: close/back/strafe/still
  hitIntervals: number[]
  hits: number
  firstContactTick: number | null
  distinctPatterns: number
}

const run = (archetype: string, seed: number): Row | null => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (p.health) { p.health.hp = 1000000; p.health.max = 1000000 }
  // Clear the ambient population so only our subject is in play.
  for (const e of w.entities) if (e.kind === 'npc') e.dead = true

  const spot = openSpotNear(w, sp.x, sp.y, 7)
  if (!spot) return null
  const n = spawnNpc(w, archetype, spot.x, spot.y)
  if (!n.ai) return null
  n.dead = false
  n.ai.dormant = false          // an ambusher that never wakes measures nothing
  n.ai.sightRange = Math.max(n.ai.sightRange ?? 6, 14)
  if (n.ai.faction === 'neutral') n.ai.faction = 'hostile'

  const wdef = WEAPONS[n.combat?.weapon ?? 'fists'] ?? WEAPONS.fists
  const row: Row = {
    archetype, behavior: n.ai.behavior ?? 'basic',
    ranged: wdef.kind === 'ranged',
    contactTicks: 0, modes: {}, goals: {}, motion: {}, hitIntervals: [], hits: 0,
    firstContactTick: null, distinctPatterns: 0,
  }
  const patterns = new Set<string>()
  let lastHit: number | null = null

  for (let t = 0; t < TICKS; t++) {
    // Player stands still and does nothing: we are measuring the NPC, not a duel.
    tickWorld(w, new Map([[0, { ...NEUTRAL }]]))
    if (n.dead) break
    for (const ev of w.events) {
      const e = ev as { type: string; targetId?: number }
      if (e.type === 'hit' && e.targetId === p.id) {
        row.hits++
        if (lastHit !== null) row.hitIntervals.push(w.tick - lastHit)
        lastHit = w.tick
      }
    }
    const dist = d2(n.pos, p.pos)
    const engaged = dist <= (row.ranged ? wdef.range * 0.8 : wdef.range + p.radius + 0.5)
    if (!engaged) continue
    if (row.firstContactTick === null) row.firstContactTick = t
    row.contactTicks++
    const mode = n.ai.mode
    const goal = n.ai.goal ?? '(none)'
    row.modes[mode] = (row.modes[mode] ?? 0) + 1
    row.goals[goal] = (row.goals[goal] ?? 0) + 1

    // Motion relative to the player: radial (closing/backing) vs tangential (strafe).
    const vx = n.pos.x - n.prevPos.x, vy = n.pos.y - n.prevPos.y
    const sp2 = Math.hypot(vx, vy)
    let m: string
    if (sp2 < 0.005) m = 'still'
    else {
      const rx = (p.pos.x - n.pos.x) / (dist || 1), ry = (p.pos.y - n.pos.y) / (dist || 1)
      const radial = (vx * rx + vy * ry) / sp2 // +1 closing, -1 backing, 0 tangential
      m = radial > 0.5 ? 'close' : radial < -0.5 ? 'back' : 'strafe'
    }
    row.motion[m] = (row.motion[m] ?? 0) + 1
    patterns.add(`${mode}|${goal}|${m}`)
  }
  row.distinctPatterns = patterns.size
  return row
}

const hostile = Object.keys(NPCS).filter((a) => a !== 'pod')
const rows: Row[] = []
for (const a of hostile) {
  for (const seed of [1001, 1003]) {
    try { const r = run(a, seed); if (r) rows.push(r) } catch (err) { rows.push({ archetype: a, behavior: `ERROR ${(err as Error).message}`, ranged: false, contactTicks: 0, modes: {}, goals: {}, motion: {}, hitIntervals: [], hits: 0, firstContactTick: null, distinctPatterns: 0 }) }
  }
}
console.log(JSON.stringify({ ticks: TICKS, archetypes: hostile, rows }, null, 2))
