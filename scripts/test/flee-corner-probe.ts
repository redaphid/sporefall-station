// Diagnostic for the reported bug: "the ai will often run into corners forever,
// especially when scared." Exploratory harness, not a unit test — it sweeps
// several corner geometries and reports net displacement of a fleeing NPC, so
// the fix can be aimed at a MEASURED cause rather than a guessed one.
//
// Run: npx tsx scripts/test/flee-corner-probe.ts

import { Tile } from '../../src/game/levelgen/level'
import { spawnNpc } from '../../src/game/populate'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const TICKS = 200

/** Carve an open floor rectangle (inclusive bounds). */
const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
}

/** Fill a rectangle back in as solid wall. */
const wall = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Wall
      w.level.solid[y * w.level.w + x] = 1
    }
}

interface Scenario {
  name: string
  /** Build geometry; return [npcX, npcY, threatX, threatY]. */
  build: (w: World, cx: number, cy: number) => [number, number, number, number]
}

const scenarios: Scenario[] = [
  {
    // Baseline: open floor, nothing to wedge on. Must escape.
    name: 'open floor (control)',
    build: (w, cx, cy) => {
      carve(w, cx - 12, cy - 12, cx + 12, cy + 12)
      return [cx, cy, cx - 3, cy]
    },
  },
  {
    // Threat to the SW, walls to the N and E: the away-vector points NE, into
    // the corner. The classic concave wedge.
    name: 'concave corner, threat pushing into it',
    build: (w, cx, cy) => {
      carve(w, cx - 12, cy - 12, cx + 12, cy + 12)
      wall(w, cx + 1, cy - 12, cx + 1, cy + 12) // wall to the east
      wall(w, cx - 12, cy + 1, cx + 12, cy + 1) // wall to the north
      return [cx, cy, cx - 3, cy - 3]
    },
  },
  {
    // A 1-tile-wide dead-end alcove, fled INTO. Only exit is back past the threat.
    name: 'dead-end alcove, threat at the mouth',
    build: (w, cx, cy) => {
      carve(w, cx - 12, cy - 2, cx + 12, cy + 2)
      wall(w, cx - 12, cy + 1, cx + 12, cy + 1)
      wall(w, cx - 12, cy - 1, cx + 12, cy - 1)
      wall(w, cx + 4, cy - 2, cx + 4, cy + 2) // dead end to the east
      return [cx + 3, cy, cx - 2, cy]
    },
  },
  {
    // THE SUSPECT: the threat's own BODY is the only thing between the fleeing
    // NPC and open floor. openFleeDir probes TILES only — it cannot see an
    // entity standing in the gap.
    name: 'cornered with the threat body blocking the only gap',
    build: (w, cx, cy) => {
      carve(w, cx - 12, cy - 12, cx + 12, cy + 12)
      wall(w, cx + 1, cy - 12, cx + 1, cy + 12)
      wall(w, cx - 12, cy + 1, cx + 12, cy + 1)
      wall(w, cx - 1, cy - 12, cx - 1, cy - 1) // pocket: only exit is south
      return [cx, cy, cx, cy - 2]
    },
  },
]

const run = (s: Scenario): void => {
  // HOSTILE world: the civilian genuinely hates and fears the thug, so flight
  // is chosen by the real arbitration rather than forced by the harness.
  const w = createWorld(1, 1, 'normal', true)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  // Seal the map so stray level geometry cannot contribute.
  wall(w, 0, 0, w.level.w - 1, w.level.h - 1)
  const [nx, ny, tx, ty] = s.build(w, cx, cy)

  // Spawn at tile CENTRES. A body has radius 0.35, so placing it on a tile
  // CORNER overlaps the neighbouring tiles and collision pins it in place —
  // which looks exactly like the bug under investigation and is not it.
  const npc = spawnNpc(w, 'civilian', nx + 0.5, ny + 0.5)
  // BADLY wounded: fleeScore scales with woundedness, so this body wants to run
  // and keeps wanting to. Huge max keeps it alive for the whole window.
  npc.health = { hp: 1, max: 1e6, iframes: 1e9 }
  npc.ai!.sightRange = 12
  const threat = spawnNpc(w, 'thug', tx + 0.5, ty + 0.5)
  threat.health = { hp: 1e6, max: 1e6, iframes: 0 }
  threat.ai = undefined // a STATIC menace: isolate flee steering from pursuit

  // Seed the panic once, then DO NOT touch it again. Re-forcing `mode` every
  // tick (an earlier version of this harness did) silently defeats any stall
  // guard, because the guard works by handing control back to arbitration.
  npc.ai!.mode = 'flee'
  npc.ai!.targetId = threat.id

  const start = { x: npc.pos.x, y: npc.pos.y }
  const input = new Map([[0, emptyInput()]])
  let moved = 0
  let stuckRun = 0
  let worstStuck = 0
  let prev = { x: npc.pos.x, y: npc.pos.y }
  const dirs = new Set<string>()
  const modes = new Set<string>()

  for (let t = 0; t < TICKS; t++) {
    tickWorld(w, input)
    const step = Math.hypot(npc.pos.x - prev.x, npc.pos.y - prev.y)
    moved += step
    if (step < 0.01) {
      stuckRun++
      worstStuck = Math.max(worstStuck, stuckRun)
    } else stuckRun = 0
    dirs.add(`${Math.round(npc.intent.x * 10)},${Math.round(npc.intent.y * 10)}`)
    modes.add(String(npc.ai!.mode))
    if (process.env.TRACE && t < 6)
      console.log(
        `      t${t} mode=${npc.ai!.mode} goal=${npc.ai!.goal} pos=(${npc.pos.x.toFixed(2)},${npc.pos.y.toFixed(2)})` +
          ` intent=(${npc.intent.x.toFixed(2)},${npc.intent.y.toFixed(2)}) step=${step.toFixed(3)}`,
      )
    prev = { x: npc.pos.x, y: npc.pos.y }
  }

  const net = Math.hypot(npc.pos.x - start.x, npc.pos.y - start.y)
  const fromThreat = Math.hypot(npc.pos.x - threat.pos.x, npc.pos.y - threat.pos.y)
  const startFromThreat = Math.hypot(start.x - threat.pos.x, start.y - threat.pos.y)
  const verdict = worstStuck > 30 ? 'WEDGED' : net < 1 ? 'NO PROGRESS' : 'escaped'

  console.log(
    [
      `${verdict.padEnd(11)} | ${s.name}`,
      `    net displacement ${net.toFixed(2)} tiles over ${TICKS} ticks (path length ${moved.toFixed(1)})`,
      `    distance from threat ${startFromThreat.toFixed(2)} -> ${fromThreat.toFixed(2)}`,
      `    longest motionless run ${worstStuck} ticks; distinct intents tried ${dirs.size}`,
      `    modes seen: ${[...modes].join(',')}`,
    ].join('\n'),
  )
}

console.log(`flee-corner probe — ${TICKS} ticks per scenario\n`)
for (const s of scenarios) run(s)
