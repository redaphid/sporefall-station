/** LITERAL reading of "the boss was spawning in other entities":
 *  does mireclaw summonBrood place adds inside WALLS or ON TOP OF entities? */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { isSolidTile } from '../../src/game/levelgen/level'
import { emptyInput } from '../../src/game/types'

const build = (seed: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  return w
}

let broodTotal = 0, inWall = 0, overlapping = 0, stuck = 0
const examples: string[] = []

for (let seed = 1; seed <= 60; seed++) {
  let w = build(seed)
  for (let floor = 1; floor <= 4; floor++) {
    const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
    if (boss && boss.archetype === 'boss') {
      // Park the party on the boss so it reveals and starts summoning.
      for (const e of w.entities) if (e.playerCtl) { e.pos.x = boss.pos.x + 2; e.pos.y = boss.pos.y; if (e.health) { e.health.hp = 1e6; e.health.max = 1e6 } }
      const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
      const known = new Set(w.entities.map((e) => e.id))
      for (let t = 0; t < 900; t++) {
        tickWorld(w, inputs)
        for (const e of w.entities) {
          if (known.has(e.id) || e.archetype !== 'sporeling') continue
          known.add(e.id)
          broodTotal++
          const solid = isSolidTile(w.level, Math.floor(e.pos.x), Math.floor(e.pos.y))
          if (solid) inWall++
          // "spawning IN other entities": centre-distance under the sum of radii
          let over: any = null
          for (const o of w.entities) {
            if (o === e || o.dead || o.projectile || !o.radius) continue
            if (Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < (o.radius + e.radius) * 0.9) { over = o; break }
          }
          if (over) overlapping++
          if (solid && examples.length < 6) examples.push(`seed${seed} f${floor}: brood#${e.id} at (${e.pos.x.toFixed(2)},${e.pos.y.toFixed(2)}) INSIDE WALL`)
          else if (over && examples.length < 6) examples.push(`seed${seed} f${floor}: brood#${e.id} spawned INSIDE '${over.archetype}'#${over.id}`)
        }
      }
      // Did any brood end the fight unable to move (entombed)?
      for (const e of w.entities) {
        if (e.archetype !== 'sporeling' || e.dead) continue
        if (isSolidTile(w.level, Math.floor(e.pos.x), Math.floor(e.pos.y))) stuck++
      }
    }
    if (floor < 4) { nextFloor(w); for (const e of w.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 } }
  }
}
console.log(`brood summoned: ${broodTotal}`)
console.log(`  spawned INSIDE A WALL : ${inWall} (${((inWall / broodTotal) * 100).toFixed(1)}%)`)
console.log(`  spawned INSIDE another entity: ${overlapping} (${((overlapping / broodTotal) * 100).toFixed(1)}%)`)
console.log(`  still standing in a wall at fight end (entombed): ${stuck}`)
for (const e of examples) console.log('   ' + e)
