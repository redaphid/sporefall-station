/** Probe: does the co-op spawn fan-out put a player inside a wall?
 *
 * Sweeps the OLD blind offsets against the NEW collision-checked placement
 * (game/spawnPlacement.playerSpawnPoint) over the same seed/floor/slot grid. */
import { generateLevel } from '../../src/game/levelgen/generate'
import { isSolidTile } from '../../src/game/levelgen/level'
import { bodyFitsAt, playerSpawnPoint } from '../../src/game/spawnPlacement'

// netHost.ts:156 / :517  — the OLD net co-op offset
const NET_OFFSET = (slot: number): number => slot * 0.6
// hostSession.ts:18 — the OLD local co-op offset
const LOCAL_OFFSET = (slot: number): number => slot * 1.5

type Place = (level: ReturnType<typeof generateLevel>, slot: number) => { x: number; y: number }

const byOffset =
  (offset: (s: number) => number): Place =>
  (level, slot) => ({ x: level.spawn.x + offset(slot), y: level.spawn.y })

const sweep = (label: string, place: Place, maxSlot: number) => {
  let badTile = 0
  let badFit = 0
  let total = 0
  const examples: string[] = []
  for (let seed = 1; seed <= 200; seed++) {
    for (let floor = 1; floor <= 5; floor++) {
      const level = generateLevel(seed, floor)
      for (let slot = 1; slot <= maxSlot; slot++) {
        total++
        const { x, y } = place(level, slot)
        const solid = isSolidTile(level, Math.floor(x), Math.floor(y))
        // The stricter, TRUE test: does the player's body actually fit here?
        const wedged = !bodyFitsAt(level, x, y)
        if (solid) badTile++
        if (wedged) badFit++
        if (wedged && examples.length < 8)
          examples.push(
            `seed=${seed} floor=${floor} slot=${slot} -> (${x.toFixed(2)},${y.toFixed(2)}) spawn=(${level.spawn.x},${level.spawn.y})`,
          )
      }
    }
  }
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`
  console.log(`${label}:`)
  console.log(`   centre tile solid : ${badTile}/${total} (${pct(badTile)})`)
  console.log(`   body cannot fit   : ${badFit}/${total} (${pct(badFit)})`)
  for (const e of examples) console.log('      ' + e)
}

console.log('=== BEFORE: blind offsets (the shipped bug) ===')
sweep('NET co-op  (netHost slot*0.6, slots 1..7)', byOffset(NET_OFFSET), 7)
sweep('LOCAL co-op (hostSession slot*1.5, slots 1..3)', byOffset(LOCAL_OFFSET), 3)

console.log('')
console.log('=== AFTER: playerSpawnPoint (collision-checked) ===')
sweep('NET co-op  (slots 1..7)', playerSpawnPoint, 7)
sweep('LOCAL co-op (slots 1..3)', playerSpawnPoint, 3)

// Distinctness: two slots must never be handed the same point, or players stack.
let dupes = 0
let pairs = 0
for (let seed = 1; seed <= 200; seed++) {
  for (let floor = 1; floor <= 5; floor++) {
    const level = generateLevel(seed, floor)
    const seen = new Set<string>()
    for (let slot = 0; slot <= 7; slot++) {
      const { x, y } = playerSpawnPoint(level, slot)
      const key = `${x},${y}`
      pairs++
      if (seen.has(key)) dupes++
      seen.add(key)
    }
  }
}
console.log('')
console.log(`slot collisions (same point handed to two slots): ${dupes}/${pairs}`)
