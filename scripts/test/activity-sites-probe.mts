// How many activity sites a generated floor offers, and how many settlers live
// within reach of a card table.
//   npx tsx scripts/test/activity-sites-probe.mts <floor> <seed...>
import { ACTIVITIES, seatsOf, takesPart } from '../../src/game/systems/activities'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { vlen } from '../../src/game/simMath'
import { createWorld } from '../../src/game/world'

const [floor, ...seeds] = process.argv.slice(2).map(Number)
for (const seed of seeds) {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const tables = w.entities.filter((e) => e.archetype === 'table')
  const cardTables = tables.filter((t) => seatsOf(w, t).length >= 2)
  const settlers = w.entities.filter((e) => e.ai && takesPart(e))
  const near = settlers.filter((s) => cardTables.some((t) => vlen(t.pos.x - s.pos.x, t.pos.y - s.pos.y) <= ACTIVITIES.cards.range))
  const count = (a: string): number => w.entities.filter((e) => e.archetype === a).length
  console.log(
    `seed ${seed} f${floor}: tables ${tables.length} (card-ready ${cardTables.length}), benches ${count('bench')}, bunks ${count('bunk')}, chairs ${count('chair')}, settlers ${settlers.length} (${near.length} near a card table)`,
  )
}
