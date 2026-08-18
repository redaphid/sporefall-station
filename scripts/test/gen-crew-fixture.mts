// Deterministic 4-player "crew" scene used to JUDGE player-identity legibility:
// four players, a hostile, and furniture all inside one phone-sized frame.
// Regenerate with:  npx tsx scripts/test/gen-crew-fixture.mts
//
// It is a pure staging fixture — no Date.now()/Math.random(), fixed seed — so
// the before/after renders in the PR are the same pixels every run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isSolidTile } from '../../src/game/levelgen/level'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld, spawnNpc } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld, type World } from '../../src/game/world'

const dir = fileURLToPath(new URL('../../src/game/__fixtures__/', import.meta.url))
mkdirSync(dir, { recursive: true })

const w: World = createWorld(7, 1)
populateWorld(w)
setupFloor(w)

// Furniture/prop tiles, so we can pick the most-furnished pocket of the map.
const props = w.entities.filter((e) => e.kind === 'interactable')
const propAt = new Set(props.map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`))

/** Free = in bounds, not a solid tile, not already occupied by a prop. */
const free = (x: number, y: number): boolean =>
  x >= 1 && y >= 1 && x < w.level.w - 1 && y < w.level.h - 1 && !isSolidTile(w.level, x, y) && !propAt.has(`${x},${y}`)

// Argmax over the map: the centre with the most props AND enough free tiles to
// stand five bodies in, within the ~7-tile radius a phone frame actually shows.
let best = { x: 0, y: 0, score: -1, spots: [] as { x: number; y: number }[] }
for (let cy = 3; cy < w.level.h - 3; cy++) {
  for (let cx = 3; cx < w.level.w - 3; cx++) {
    if (!free(cx, cy)) continue
    let nProps = 0
    const spots: { x: number; y: number }[] = []
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (propAt.has(`${x},${y}`)) nProps++
        else if (free(x, y) && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) spots.push({ x, y })
      }
    if (spots.length < 6) continue
    if (nProps > best.score) best = { x: cx, y: cy, score: nProps, spots }
  }
}

// Deterministic pick: the free tiles nearest the centre, ordered, so the crew
// clusters the way a real firefight huddle does instead of standing in a line.
const near = best.spots
  .slice()
  .sort((a, b) => Math.hypot(a.x - best.x, a.y - best.y) - Math.hypot(b.x - best.x, b.y - best.y) || a.y - b.y || a.x - b.x)

// Players 0..3. Player 0 is spawned FIRST so `main.ts` picks it as `self`
// (`entities.find(e => e.playerCtl)`), matching a real host session.
const crew = [near[0], near[2], near[4], near[6]]
crew.forEach((p, i) => spawnPlayer(w, i, p.x + 0.5, p.y + 0.5))

// One hostile in the same frame — the render must prove player markers do not
// out-shout a threat.
const foe = near[near.length - 1]
const thug = spawnNpc(w, 'thug', foe.x + 0.5, foe.y + 0.5)
thug.ai!.mode = 'idle'

const json = serializeWorld(w)
writeFileSync(`${dir}crew-scene.json`, JSON.stringify(json, null, 2) + '\n')
console.log(
  `crew-scene: seed 7, centre ${best.x},${best.y}, ${best.score} props in radius, ` +
    `crew ${crew.map((c) => `${c.x},${c.y}`).join(' ')}, thug ${foe.x},${foe.y}`,
)

// ── crew-scene-8: the WORST case the markers have to survive — a full
// MAX_PLAYERS lobby packed into one phone frame, with one of them DOWNED. If
// identity survives this it survives anything the game can produce.
const w8: World = createWorld(7, 1)
populateWorld(w8)
setupFloor(w8)
const eight = near.slice(0, 8)
eight.forEach((p, i) => spawnPlayer(w8, i, p.x + 0.5, p.y + 0.5))
const thug8 = spawnNpc(w8, 'thug', foe.x + 0.5, foe.y + 0.5)
thug8.ai!.mode = 'idle'
// Player 6 (slot 5) is bleeding out: the downed cue is red PLUS a struck-through
// X, so it stays legible with no colour vision at all.
const fallen = w8.entities.find((e) => e.playerCtl?.playerId === 5)!
fallen.playerCtl!.downed = { bleedTicks: 400, reviveProgress: 0 }
writeFileSync(`${dir}crew-scene-8.json`, JSON.stringify(serializeWorld(w8), null, 2) + '\n')
console.log(`crew-scene-8: 8 players (P6 downed) at ${eight.map((c) => `${c.x},${c.y}`).join(' ')}`)
