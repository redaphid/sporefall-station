// Build the exact-world snapshots behind the heist-finale tour video
// (e2e/heist-tour.mjs): one steal-mission floor captured at the three beats —
// sealed quest gate, gateway breach (station unseals: every door pops open),
// and prize grab (every unit in town aggros the holder). Stages 2 and 3 are
// produced by running the REAL sim (missionSystem) on the stage-1 world, so
// the video shows the actual mechanics, not a mock-up.
//
//   pnpm exec tsx scripts/test/gen-heist-tour.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { deserializeWorld, serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput, type Annotation, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const OUT = process.argv[2] ?? 'e2e/output/heist-fixtures'
mkdirSync(OUT, { recursive: true })

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

/** A steal floor whose gate sits on a themed floor (2+: dressed access gate). */
const bootSteal = (): World => {
  for (let seed = 1; seed <= 300; seed++) {
    for (const floor of [2, 3]) {
      const w = createWorld(seed, floor)
      populateWorld(w)
      setupFloor(w)
      if (w.mission.template !== 'steal' || w.mission.objectiveDoorId === undefined) continue
      if (!w.entities.some((e) => e.ai && !e.dead)) continue
      spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
      return w
    }
  }
  throw new Error('no steal floor found')
}

const write = (name: string, w: World, notes: Annotation[]): void => {
  w.annotations = notes.map((n, i) => ({ ...n, id: `heist-${i}` }))
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(serializeWorld(w)))
  console.log(`${name}: alarm=${w.alarm} complete=${w.mission.complete}`)
}

const base = bootSteal()
const gate = base.byId.get(base.mission.objectiveDoorId!)!
const player = base.entities.find((e) => e.playerCtl)!
// Park the player just outside the gate so all three beats frame the same spot.
player.pos.x = gate.pos.x
player.pos.y = gate.pos.y + 2
player.prevPos.x = player.pos.x
player.prevPos.y = player.pos.y

// ── Stage 1: the sealed quest gate ───────────────────────────────────────────
write('heist-1-sealed', deserializeWorld(serializeWorld(base)), [
  { id: 0, kind: 'label', x: gate.pos.x, y: gate.pos.y - 1.2, text: 'QUEST GATE — sealed', color: '#ffd24a' },
  { id: 0, kind: 'circle', x: gate.pos.x, y: gate.pos.y, radius: 1.2, color: '#ffd24a' },
])

// ── Stage 2: breach → the station unseals ────────────────────────────────────
const w2 = deserializeWorld(serializeWorld(base))
const gate2 = w2.byId.get(w2.mission.objectiveDoorId!)!
gate2.door!.locked = false
gate2.door!.open = true
tickWorld(w2, idle()) // missionSystem fires the release
if (!w2.mission.bossAggroTriggered) throw new Error('breach did not latch')
const releasedCount = w2.entities.filter((e) => e.door && e.door.open && e.id !== gate2.id).length
write('heist-2-breach', w2, [
  { id: 0, kind: 'label', x: gate2.pos.x, y: gate2.pos.y - 1.2, text: 'BREACH — every door on the map released', color: '#ff8a4a' },
  { id: 0, kind: 'circle', x: gate2.pos.x, y: gate2.pos.y, radius: 1.2, color: '#ff8a4a' },
])
console.log(`  released doors now open: ${releasedCount}`)

// ── Stage 3: prize grab → the whole town aggros the holder ───────────────────
const w3 = deserializeWorld(serializeWorld(w2))
const p3 = w3.entities.find((e) => e.playerCtl)!
p3.loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
tickWorld(w3, idle()) // missionSystem completes + raises the manhunt
if (!w3.mission.complete || w3.alarm !== 3) throw new Error('prize did not raise the manhunt')
write('heist-3-manhunt', w3, [
  { id: 0, kind: 'label', x: p3.pos.x, y: p3.pos.y - 1.6, text: 'PRIZE TAKEN — every unit converges', color: '#ff5a5a' },
  { id: 0, kind: 'circle', x: p3.pos.x, y: p3.pos.y, radius: 1.4, color: '#ff5a5a' },
])
console.log(`heist fixtures in ${OUT}`)
