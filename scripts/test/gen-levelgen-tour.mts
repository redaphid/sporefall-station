// Build the exact-world snapshots behind the levelgen-architecture tour video
// (e2e/levelgen-tour.mjs): themed-floor worlds with the player teleported to
// each new set-piece — bunker airlock, hallway spine, courtyard pit — with
// annotation labels narrating what the camera is looking at. Deterministic:
// fixed seeds through the real createWorld/populate/setupFloor path.
//
//   pnpm exec tsx scripts/test/gen-levelgen-tour.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { WALL_CUT_OUTSIDE, type Building } from '../../src/game/levelgen/level'
import { createWorld, type World } from '../../src/game/world'
import type { Annotation } from '../../src/game/types'

const OUT = process.argv[2] ?? 'e2e/output/tour-fixtures'
mkdirSync(OUT, { recursive: true })

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

const byPoi = (w: World, poi: Building['poi']): Building | undefined =>
  w.level.buildings.find((b) => b.poi === poi)

/** Outward-facing tile just outside a door on the building shell. */
const outsideDoor = (b: Building, d: { x: number; y: number }): { x: number; y: number } => {
  if (d.y === b.rect.y) return { x: d.x, y: d.y - 1 }
  if (d.y === b.rect.y + b.rect.h - 1) return { x: d.x, y: d.y + 1 }
  if (d.x === b.rect.x) return { x: d.x - 1, y: d.y }
  return { x: d.x + 1, y: d.y }
}

const write = (name: string, w: World, px: number, py: number, notes: Annotation[]): void => {
  const player = w.entities.find((e) => e.playerCtl)
  if (player) {
    player.pos.x = px + 0.5
    player.pos.y = py + 0.5
    player.prevPos.x = player.pos.x
    player.prevPos.y = player.pos.y
  } else {
    spawnPlayer(w, 0, px + 0.5, py + 0.5)
  }
  w.annotations = notes.map((n, i) => ({ ...n, id: `tour-${i}` }))
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(serializeWorld(w)))
  console.log(`${name}: player at ${px},${py}, ${notes.length} labels`)
}

// ── Scene 1: industrial floor 3 — bunker airlock ─────────────────────────────
{
  const w = buildFloor(7, 3)
  const b = byPoi(w, 'bunker')!
  const outer = b.doors[0]
  const inner = b.doors[1]
  const core = b.rooms[b.rooms.length - 1]
  const spot = outsideDoor(b, outer)
  write('tour-1-bunker', w, spot.x, spot.y, [
    { id: 0, kind: 'label', x: outer.x + 0.5, y: outer.y - 1.5, text: 'BUNKER — airlock entry', color: '#ffd24a' },
    { id: 0, kind: 'circle', x: outer.x + 0.5, y: outer.y + 0.5, radius: 1.2, color: '#ffd24a' },
    { id: 0, kind: 'pin', x: inner.x + 0.5, y: inner.y + 0.5, text: 'inner door', color: '#ff8a4a' },
    { id: 0, kind: 'label', x: core.x + core.w / 2, y: core.y - 0.6, text: 'innermost chamber (mission slot)', color: '#ff8a4a' },
  ])
}

// ── Scene 2: same district — hallway-spine offices ───────────────────────────
{
  const w = buildFloor(7, 3)
  const b = byPoi(w, 'hallway')!
  const spine = b.rooms[0]
  const cx = Math.floor(spine.x + spine.w / 2)
  const cy = Math.floor(spine.y + spine.h / 2)
  write('tour-2-hallway', w, cx, cy, [
    { id: 0, kind: 'label', x: cx + 0.5, y: spine.y - 1, text: 'HALLWAY SPINE — rooms hang off the corridor', color: '#7fd1ff' },
    { id: 0, kind: 'circle', x: cx + 0.5, y: cy + 0.5, radius: 1.4, color: '#7fd1ff' },
  ])
}

// ── Scene 3: same district — courtyard compound pit ──────────────────────────
{
  const w = buildFloor(7, 3)
  const b = byPoi(w, 'courtyard')!
  const cx = Math.floor(b.rect.x + b.rect.w / 2)
  const cy = Math.floor(b.rect.y + b.rect.h / 2)
  write('tour-3-courtyard', w, cx, cy, [
    { id: 0, kind: 'label', x: cx + 0.5, y: b.rect.y + 0.4, text: 'COURTYARD COMPOUND — fight in the pit', color: '#8aff8a' },
    { id: 0, kind: 'circle', x: cx + 0.5, y: cy + 0.5, radius: 2.2, color: '#8aff8a' },
  ])
}

// ── Scene 4: downtown floor 5 — bevelled street corner + boulevard ───────────
{
  const w = buildFloor(11, 5)
  // First cut-corner tile with open street around it.
  let cut: { x: number; y: number } | null = null
  outer: for (let y = 0; y < w.level.h; y++) {
    for (let x = 0; x < w.level.w; x++) {
      if (WALL_CUT_OUTSIDE[w.level.tiles[y * w.level.w + x]]) {
        cut = { x, y }
        break outer
      }
    }
  }
  const c = cut!
  const d = WALL_CUT_OUTSIDE[w.level.tiles[c.y * w.level.w + c.x]]
  const spot = { x: c.x + d.dx * 2, y: c.y + d.dy * 2 }
  // Ensure the vantage tile is open ground; walk outward until it is.
  while (w.level.solid[spot.y * w.level.w + spot.x] === 1) {
    spot.x += d.dx
    spot.y += d.dy
  }
  write('tour-4-corners', w, spot.x, spot.y, [
    { id: 0, kind: 'label', x: c.x + 0.5, y: c.y - 1.2, text: 'BEVELLED CORNERS — 45° cut walls', color: '#ff7fd1' },
    { id: 0, kind: 'circle', x: c.x + 0.5, y: c.y + 0.5, radius: 1, color: '#ff7fd1' },
  ])
}
console.log(`tour fixtures in ${OUT}`)
