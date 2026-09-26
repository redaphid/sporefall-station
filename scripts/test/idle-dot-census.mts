/**
 * Which bodies take damage over time during the extraction test's idle boot
 * (seed:floor keys on the command line, 30 idle ticks each, as
 * gen-mission-baseline.mts builds them)? Explains a moved baseline hash: a DoT
 * hit now stamps `lastHurtTick` (#130), and a fractional resist now deals its
 * share and banks `prepaid` on the status (#131).
 *
 * Run: npx tsx scripts/test/idle-dot-census.mts 1:5 19:7
 */
import { ELEMENTS } from '../../src/game/data/elements'
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

for (const key of process.argv.slice(2)) {
  const [seed, floor] = key.split(':').map(Number)
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  const seen = new Map<number, string>()
  for (let t = 0; t < 30; t++) {
    tickWorld(w, new Map([[0, emptyInput()]]))
    const tick = w.tick - 1
    for (const ev of w.events) {
      if (ev.type !== 'hit') continue
      const e = w.byId.get(ev.targetId)
      // A hit on a body carrying a DoT, on that DoT's damage tick. A weapon hit
      // landing on the same tick would be counted too.
      const dots = Object.keys(e?.fx ?? {}).filter((k) => (ELEMENTS[k]?.dot ?? 0) > 0 && tick % ELEMENTS[k].interval === 0)
      if (!e || dots.length === 0 || seen.has(e.id)) continue
      const resist = dots.map((k) => `${k} ${e.resist?.[k] ?? 1}`).join(', ')
      seen.set(e.id, `${e.archetype}#${e.id} first DoT hit @${tick} (${resist})`)
    }
  }
  console.log(`${key}: ${seen.size ? [...seen.values()].join('; ') : 'no DoT hits'}`)
}
