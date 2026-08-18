/** How many bytes/sec of RELIABLE Events does the host emit around a boss release? */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'
import { encodeJson } from '../../src/net/framing/codec'
import { MAX_MESSAGE_BYTES } from '../../src/net/framing/chunkedStream'

const PLAYERS = 4

const build = (seed: number, floor: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < PLAYERS; s++) spawnPlayer(w, s, w.level.spawn.x + s * 0.6, w.level.spawn.y)
  while (w.floor < floor) nextFloor(w)
  return w
}

for (const [seed, floor] of [[20260808, 1], [99, 1], [1234, 2], [42, 3]] as [number, number][]) {
  const w = build(seed, floor)
  if (w.mission.template !== 'assassinate' && w.mission.template !== 'infiltrate') { console.log(`seed ${seed} f${floor}: ${w.mission.template}, skip`); continue }
  const gate = w.mission.objectiveDoorId !== undefined ? w.byId.get(w.mission.objectiveDoorId) : undefined
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!gate?.door || !boss) { console.log(`seed ${seed} f${floor}: no gate/boss`); continue }
  // Park the party right on the boss so the reveal fires and the fight is live.
  for (const e of w.entities) {
    if (!e.playerCtl) continue
    e.pos.x = boss.pos.x + 1.2; e.pos.y = boss.pos.y
    if (e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  }
  const inputs = new Map(Array.from({ length: PLAYERS }, (_, s) => [s, { ...emptyInput() }]))
  const measure = (label: string, ticks: number) => {
    let bytes = 0, maxMsg = 0, over = 0, maxCount = 0, ticksWithEvents = 0
    for (let t = 0; t < ticks; t++) {
      tickWorld(w, inputs)
      if (w.events.length === 0) continue
      ticksWithEvents++
      const msg = encodeJson(6, { tick: w.tick, events: w.events })
      bytes += msg.length
      maxMsg = Math.max(maxMsg, msg.length)
      maxCount = Math.max(maxCount, w.events.length)
      if (msg.length > MAX_MESSAGE_BYTES) over++
    }
    console.log(`  ${label}: ${(bytes / (ticks / 30)).toFixed(0)} B/s reliable events | maxMsg=${maxMsg}B maxEvents=${maxCount} ticksWithEvents=${ticksWithEvents}/${ticks} overMAX=${over} entities=${w.entities.length}`)
  }
  console.log(`seed ${seed} floor ${floor} (${w.mission.template}):`)
  measure('BEFORE breach', 300)
  gate.door.locked = false; gate.door.open = true
  measure('AFTER  breach', 300)
}
