// Exact-world snapshots behind the indoor-complex screenshots/video
// (e2e/indoor-complex.mjs): one populated complex floor per biome with the
// player parked at a readable vantage point and labels naming the modules,
// plus a "director" scene whose event schedule is pulled forward so a vent
// swarm and a wing lights-out fire seconds after the world loads in the live
// build. Deterministic: fixed seeds through createWorld/populate/setupFloor.
//
//   pnpm exec tsx scripts/test/gen-indoor-tour.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Building } from '../../src/game/levelgen/level'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { complexDirectorSystem, VENT_MAX_DIST, VENT_MIN_DIST } from '../../src/game/systems/complexDirector'
import { setupFloor } from '../../src/game/systems/missions'
import type { Annotation } from '../../src/game/types'
import { createWorld, type World } from '../../src/game/world'

const OUT = process.argv[2] ?? 'e2e/output/indoor-fixtures'
mkdirSync(OUT, { recursive: true })

const ROLE_LABEL: Record<string, string> = {
  mess: 'MESS HALL',
  galley: 'GALLEY',
  quarters: 'CREW BUNKS',
  washroom: 'WASH BLOCK',
  lab: 'ESSENCE LAB',
  medbay: 'INFIRMARY',
  reactor: 'REACTOR HALL',
  depot: 'STORES',
  security: 'SECURITY',
}
const ROLE_COLOR: Record<string, string> = {
  mess: '#ffd27f',
  galley: '#ffb27f',
  quarters: '#9fd0ff',
  washroom: '#bfefff',
  lab: '#b8ff9f',
  medbay: '#ff9fb0',
  reactor: '#ff8f5f',
  depot: '#d8c8a8',
  security: '#8fb0ff',
}

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

const centre = (b: Building): { x: number; y: number } => ({
  x: b.rooms[0].x + b.rooms[0].w / 2,
  y: b.rooms[0].y + b.rooms[0].h / 2,
})

/** Label every module within `r` tiles of the vantage point. */
const labelsNear = (w: World, px: number, py: number, r: number): Annotation[] => {
  const out: Annotation[] = []
  for (const b of w.level.buildings) {
    const c = centre(b)
    if (Math.hypot(c.x - px, c.y - py) > r) continue
    out.push({ id: '', kind: 'label', x: c.x, y: c.y, text: ROLE_LABEL[b.role] ?? b.role, color: ROLE_COLOR[b.role] ?? '#ffffff' } as Annotation)
  }
  for (const v of w.level.complex!.vents) {
    if (Math.hypot(v.x - px, v.y - py) > r) continue
    out.push({ id: '', kind: 'circle', x: v.x + 0.5, y: v.y + 0.5, radius: 0.8, color: '#7fd65a' } as Annotation)
  }
  return out
}

const write = (name: string, w: World, px: number, py: number, notes: Annotation[]): void => {
  const player = w.entities.find((e) => e.playerCtl) ?? spawnPlayer(w, 0, px, py)
  player.pos.x = px
  player.pos.y = py
  player.prevPos.x = px
  player.prevPos.y = py
  w.annotations = notes.map((n, i) => ({ ...n, id: `indoor-${i}` }))
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(serializeWorld(w)))
  console.log(`${name}: floor ${w.floor} biome ${w.level.complex!.biome}, player at ${px},${py}, ${notes.length} marks`)
}

/** The tile centre just inside a module's first door (standing in the room). */
const inDoor = (b: Building): { x: number; y: number } => {
  const d = b.doors[0]
  const r = b.rooms[0]
  const x = Math.min(Math.max(d.x, r.x), r.x + r.w - 1)
  const y = Math.min(Math.max(d.y, r.y), r.y + r.h - 1)
  return { x: x + 0.5, y: y + 0.5 }
}

// Scenes 1-4: one per biome, parked just inside the mess hall (or the biggest room).
const biomeScenes: [string, number, number][] = [
  ['indoor-1-habitation', 3, 3],
  ['indoor-2-flooded', 3, 4],
  ['indoor-3-reactor', 3, 5],
  ['indoor-4-overgrown', 3, 6],
]
for (const [name, seed, floor] of biomeScenes) {
  const w = buildFloor(seed, floor)
  const mess =
    w.level.buildings.find((b) => b.role === 'mess') ??
    [...w.level.buildings].sort((a, b) => b.rooms[0].w * b.rooms[0].h - a.rooms[0].w * a.rooms[0].h)[0]
  const at = inDoor(mess)
  // Clear hostiles right at the vantage point so the still is the architecture,
  // not a brawl on the doorstep.
  for (const e of w.entities) if (e.ai && Math.hypot(e.pos.x - at.x, e.pos.y - at.y) < 6) e.dead = true
  write(name, w, at.x, at.y, labelsNear(w, at.x, at.y, 22))
}

// Scene 5: the director live — a corridor spot in a vent's band, with the vent
// swarm and a lights-out both scheduled ~1-2 s after load.
{
  const w = buildFloor(3, 3)
  const players = [spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)]
  let spot: { x: number; y: number } | null = null
  for (const c of w.level.complex!.corridors) {
    for (let y = c.rect.y; y < c.rect.y + c.rect.h && !spot; y++) {
      for (let x = c.rect.x; x < c.rect.x + c.rect.w && !spot; x++) {
        const ok = w.level.complex!.vents.some((v) => {
          const d = Math.hypot(v.x - x, v.y - y)
          return d >= VENT_MIN_DIST + 1 && d <= VENT_MIN_DIST + 3
        })
        if (ok && Math.hypot(x - w.level.spawn.x, y - w.level.spawn.y) > 12) spot = { x: x + 0.5, y: y + 0.5 }
      }
    }
  }
  if (!spot) throw new Error('no vent vantage')
  players[0].pos = { ...spot }
  players[0].prevPos = { ...spot }
  complexDirectorSystem(w) // plan the schedule
  w.director!.nextVentAt = w.tick + 45
  w.director!.nextLightsAt = w.tick + 75
  for (const e of w.entities) if (e.ai && Math.hypot(e.pos.x - spot.x, e.pos.y - spot.y) < 10) e.dead = true
  void VENT_MAX_DIST
  write('indoor-5-director', w, spot.x, spot.y, [
    ...labelsNear(w, spot.x, spot.y, 14),
    { id: '', kind: 'label', x: spot.x, y: spot.y - 1.6, text: 'VENT SWARM + LIGHTS OUT incoming', color: '#7fd65a' } as Annotation,
  ])
}
console.log(`indoor fixtures in ${OUT}`)
