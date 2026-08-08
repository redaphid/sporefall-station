// Is the Mireclaw Alpha REACHABLE? A peer agent's AI-sim telemetry
// (`sealOpen` fired 0 times in 30 runs) raised the hypothesis that the boss
// spawns behind a biolock the player can never open. This measures it.
//
// For every boss floor it reports: whether the boss tile is reachable from the
// player spawn through the walkable graph, what seal (if any) guards the
// gateway, and whether that seal's KEY actually spawned in the world.
//
//   npx tsx scripts/test/boss-reach-census.ts [seeds] [maxFloor]

import { isSolidTile, type Level } from '../../src/game/levelgen/level'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld, type World } from '../../src/game/world'

const SEEDS = Number(process.argv[2] ?? 200)
const MAX_FLOOR = Number(process.argv[3] ?? 20)

/** Flood fill from the spawn tile over every non-solid tile. Door TILES are
 * walkable floor (a lock is an entity overlay, not terrain), so this answers
 * the pure geometry question: is there any route at all? */
const reachable = (level: Level, fromX: number, fromY: number, toX: number, toY: number): boolean => {
  const seen = new Uint8Array(level.w * level.h)
  const q: number[] = [Math.floor(fromY) * level.w + Math.floor(fromX)]
  seen[q[0]] = 1
  const goal = Math.floor(toY) * level.w + Math.floor(toX)
  while (q.length > 0) {
    const i = q.pop()!
    if (i === goal) return true
    const x = i % level.w
    const y = (i - x) / level.w
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue
      const ni = ny * level.w + nx
      if (seen[ni] || isSolidTile(level, nx, ny)) continue
      seen[ni] = 1
      q.push(ni)
    }
  }
  return false
}

/** Classify the objective gateway's seal and whether its key exists in-world. */
const sealReport = (w: World): { seal: string; keyPresent: boolean } => {
  const gateId = w.mission.objectiveDoorId
  const gate = gateId !== undefined ? w.byId.get(gateId) : undefined
  const d = gate?.door
  if (!d) return { seal: 'none', keyPresent: true }
  if (d.overgrown) {
    const node = d.nodeId !== undefined ? w.byId.get(d.nodeId) : undefined
    return { seal: 'overgrown', keyPresent: !!node && !node.dead }
  }
  if (d.sealKind === 'keycard') {
    const card = w.entities.some((e) => e.pickup?.itemId === d.keyId)
    return { seal: 'keycard', keyPresent: card }
  }
  if (d.sealKind === 'power') {
    const gen = w.entities.some((e) => e.archetype === 'generator' && e.wing === d.wing)
    return { seal: 'power', keyPresent: gen }
  }
  return { seal: d.locked ? 'pick' : 'open', keyPresent: true }
}

interface Acc {
  bossFloors: number
  reach: number
  seals: Record<string, number>
  keyMissing: Record<string, number>
}

const perFloor: Acc[] = []
for (let floor = 1; floor <= MAX_FLOOR; floor++) {
  const a: Acc = { bossFloors: 0, reach: 0, seals: {}, keyMissing: {} }
  for (let s = 0; s < SEEDS; s++) {
    const w = createWorld(1000 + s, floor)
    populateWorld(w)
    setupFloor(w)
    const boss = w.entities.find((e) => e.archetype === 'boss' && !e.dead)
    if (!boss) continue
    a.bossFloors++
    if (reachable(w.level, w.level.spawn.x, w.level.spawn.y, boss.pos.x, boss.pos.y)) a.reach++
    const { seal, keyPresent } = sealReport(w)
    a.seals[seal] = (a.seals[seal] ?? 0) + 1
    if (!keyPresent) a.keyMissing[seal] = (a.keyMissing[seal] ?? 0) + 1
  }
  perFloor.push(a)
}

console.log(`seeds=${SEEDS} floors=1..${MAX_FLOOR}`)
console.log('floor  bossFloors  reachable  seal breakdown                         key-missing')
for (let i = 0; i < perFloor.length; i++) {
  const a = perFloor[i]
  const seals = Object.entries(a.seals).sort().map(([k, v]) => `${k}:${v}`).join(' ')
  const miss = Object.entries(a.keyMissing).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '-'
  console.log(
    `${String(i + 1).padStart(5)}  ${String(a.bossFloors).padStart(10)}  ${String(a.reach).padStart(9)}  ${seals.padEnd(38)} ${miss}`,
  )
}

const tot = perFloor.reduce((a, r) => a + r.bossFloors, 0)
const reach = perFloor.reduce((a, r) => a + r.reach, 0)
const missing = perFloor.reduce((a, r) => a + Object.values(r.keyMissing).reduce((x, y) => x + y, 0), 0)
console.log(`\nboss floors: ${tot}`)
console.log(`boss tile reachable from spawn: ${reach}/${tot} (${((reach / tot) * 100).toFixed(1)}%)`)
console.log(`gateway seals with NO key in world: ${missing}/${tot} (${((missing / tot) * 100).toFixed(1)}%)`)
