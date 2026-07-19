// Property sweep: for many seeds × floors, generate the real world (populate +
// setupFloor, exactly like HostSession) and audit the mission target chain:
//   - does the mission target entity exist?
//   - is its position inside the designated target building's rect?
//   - is the tile under it walkable (not a wall/void)?
//   - does roomCenter's room (last room) look sane per archetype?
// Prints one line per anomaly + a summary histogram.
import { createWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { isWallTile, tileAt, Tile } from '../../src/game/levelgen/level'

const SEEDS = Number(process.env.SEEDS ?? 60)
const FLOORS = Number(process.env.FLOORS ?? 3)

interface Anomaly {
  kind: string
  seed: number
  floor: number
  detail: string
}
const anomalies: Anomaly[] = []
const kinds = new Map<string, number>()
const note = (kind: string, seed: number, floor: number, detail: string) => {
  anomalies.push({ kind, seed, floor, detail })
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
}

let total = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  for (let floor = 1; floor <= FLOORS; floor++) {
    total++
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    const m = w.mission
    if (m.template === 'reach') continue
    const tid = m.targetEntityId
    const target = tid !== undefined ? w.byId.get(tid) : undefined
    if (!target) {
      note('no-target-entity', seed, floor, `template=${m.template}`)
      continue
    }
    const bIdx = m.targetBuilding ?? -1
    const b = w.level.buildings[bIdx]
    if (!b) {
      note('no-target-building', seed, floor, `idx=${bIdx}`)
      continue
    }
    const { x, y } = target.pos
    const tx = Math.floor(x)
    const ty = Math.floor(y)
    const inRect = tx >= b.rect.x && tx < b.rect.x + b.rect.w && ty >= b.rect.y && ty < b.rect.y + b.rect.h
    const tile = tileAt(w.level, tx, ty)
    const onWall = isWallTile(tile)
    const room = b.rooms[b.rooms.length - 1]
    if (!inRect)
      note(
        'target-outside-building',
        seed,
        floor,
        `${m.template} pos=(${x.toFixed(1)},${y.toFixed(1)}) bld=[${b.rect.x},${b.rect.y} ${b.rect.w}x${b.rect.h}] poi=${b.poi ?? 'plain'} lastRoom=[${room?.x},${room?.y} ${room?.w}x${room?.h}] theme=${w.level.theme}`,
      )
    if (onWall)
      note(
        'target-in-wall',
        seed,
        floor,
        `${m.template} pos=(${x.toFixed(1)},${y.toFixed(1)}) tile=${tile} poi=${b.poi ?? 'plain'} lastRoom=[${room?.x},${room?.y} ${room?.w}x${room?.h}]`,
      )
    if (!onWall && tile !== Tile.Floor && inRect)
      note('target-not-on-floor-tile', seed, floor, `${m.template} tile=${tile} poi=${b.poi ?? 'plain'} pos=(${x.toFixed(1)},${y.toFixed(1)})`)
    // Degenerate room rect (zero/negative area) would put roomCenter anywhere.
    if (room && (room.w <= 0 || room.h <= 0)) note('degenerate-last-room', seed, floor, `room=[${room.x},${room.y} ${room.w}x${room.h}] poi=${b.poi ?? 'plain'}`)
  }
}

console.log(`swept ${total} worlds (${SEEDS} seeds x ${FLOORS} floors)`)
for (const [k, n] of kinds) console.log(`  ${k}: ${n}`)
if (anomalies.length === 0) console.log('  no anomalies')
for (const a of anomalies.slice(0, 40)) console.log(`${a.kind} seed=${a.seed} floor=${a.floor} ${a.detail}`)

// Baseline dump mode: print target placements for regression pinning.
if (process.env.DUMP_BASELINE) {
  for (let seed = 1; seed <= 12; seed++) {
    for (let floor = 1; floor <= 4; floor++) {
      const w = createWorld(seed, floor)
      populateWorld(w)
      setupFloor(w)
      const t = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
      console.log(`BASE seed=${seed} floor=${floor} tpl=${w.mission.template} bld=${w.mission.targetBuilding} pos=${t ? `${t.pos.x},${t.pos.y}` : 'none'}`)
    }
  }
}
