/** After "New Seed", the client's STALE selfId (from the old run) can match a
 *  NON-PLAYER entity of the new world that is inside the first snapshot.
 *  Find seed pairs where that happens. */
import { createWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'

const INTEREST_RADIUS = 14, CAP = 48

const build = (seed: number, players: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  const ids: number[] = []
  ids.push(spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y).id)
  for (let s = 1; s < players; s++) ids.push(spawnPlayer(w, s, w.level.spawn.x + s * 0.6, w.level.spawn.y).id)
  return { w, ids }
}

/** Exactly netHost.sendSnapshots' selection, for the client at `slot`. */
const snapshotIds = (w: any, avatarId: number): Set<number> => {
  const avatar = w.byId.get(avatarId)
  const out: number[] = []; const nearby: { e: any; d: number }[] = []
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.playerCtl !== undefined) { if (out.length < CAP) out.push(e.id); continue }
    const dx = Math.abs(e.pos.x - avatar.pos.x), dy = Math.abs(e.pos.y - avatar.pos.y)
    if (dx >= INTEREST_RADIUS || dy >= INTEREST_RADIUS) continue
    nearby.push({ e, d: Math.max(dx, dy) })
  }
  if (out.length + nearby.length > CAP) nearby.sort((a, b) => (a.d === b.d ? a.e.id - b.e.id : a.d - b.d))
  for (const n of nearby) { if (out.length >= CAP) break; out.push(n.e.id) }
  return new Set(out)
}

const PLAYERS = 4, SLOT = 1
let hits = 0, tried = 0
const examples: string[] = []
for (let a = 1; a <= 60; a++) {
  const A = build(a, PLAYERS)
  const staleSelfId = A.ids[SLOT]
  for (let b = 1; b <= 60; b++) {
    if (b === a) continue
    tried++
    const B = build(b, PLAYERS)
    const target = B.w.byId.get(staleSelfId)
    if (!target || target.playerCtl) continue          // absent or still a player -> harmless
    if (!snapshotIds(B.w, B.ids[SLOT]).has(staleSelfId)) continue  // not in the first snapshot
    hits++
    if (examples.length < 10) examples.push(`oldSeed=${a} newSeed=${b} staleSelfId=${staleSelfId} -> new-world entity is '${target.archetype}' (kind=${target.kind})`)
  }
}
console.log(`seed pairs where the stale selfId binds to a NON-PLAYER inside the first snapshot: ${hits}/${tried} (${((hits / tried) * 100).toFixed(1)}%)`)
for (const e of examples) console.log('   ' + e)
