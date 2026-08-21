/** Every archetype the host can actually spawn vs the ARCHETYPES wire registry.
 *  A gap encodes as index 0 and DECODES AS 'player' on the other phone. */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'
import { ARCHETYPES, normalizeArchetype } from '../../src/net/protocol/messages'

const known = new Set<string>(ARCHETYPES)
const gaps = new Map<string, string>()   // archetype -> first sighting
const seen = new Set<string>()

const scan = (w: any, where: string) => {
  for (const e of w.entities) {
    const a = normalizeArchetype(e.archetype)
    seen.add(a)
    if (!known.has(a) && !gaps.has(a)) gaps.set(a, `${where} (kind=${e.kind})`)
  }
}

for (let seed = 1; seed <= 40; seed++) {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  for (const e of w.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
  for (let floor = 1; floor <= 6; floor++) {
    // Boss floors: park the party on the target and breach the gate so the boss
    // reveals, summons brood and the floor escalates.
    const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
    if (boss) for (const e of w.entities) { if (e.playerCtl) { e.pos.x = boss.pos.x + 1.5; e.pos.y = boss.pos.y } }
    const gate = w.mission.objectiveDoorId !== undefined ? w.byId.get(w.mission.objectiveDoorId) : undefined
    if (gate?.door) { gate.door.locked = false; gate.door.open = true }
    scan(w, `seed${seed} f${floor} ${w.mission.template}`)
    for (let t = 0; t < 400; t++) { tickWorld(w, inputs); if (t % 50 === 0) scan(w, `seed${seed} f${floor} ${w.mission.template} t${t}`) }
    scan(w, `seed${seed} f${floor} ${w.mission.template} end`)
    if (floor < 6) { nextFloor(w); for (const e of w.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 } }
  }
}
console.log(`distinct archetypes actually spawned: ${seen.size}`)
console.log(`ARCHETYPES registry size: ${ARCHETYPES.length}`)
if (gaps.size === 0) console.log('NO GAPS: every spawned archetype is in the wire registry.')
else {
  console.log(`WIRE REGISTRY GAPS (${gaps.size}) — these arrive on the other phone as 'player':`)
  for (const [a, where] of [...gaps].sort()) console.log(`   - ${a}   first seen: ${where}`)
}
