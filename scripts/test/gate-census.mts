// Census of the objective's access gate: with every sealed gate CLOSED (a
// keycard/power biolock or an overgrown hatch), can a player walk from the spawn
// to the gate's soft key (keycard pickup, generator or feeder Spore Node), and
// to the objective itself? A floor where neither is reachable can only be won by
// breaching the seal with the special grenade.
//
// Run: pnpm exec tsx scripts/test/gate-census.mts [seeds=60] [floors=3,4]
//
// Plain locked doors count as passable (every lock is pickable). Stairs are
// followed. The world is built the way the host builds it: populate, then
// setupFloor.

import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld, type World } from '../../src/game/world'
import { isSolidTile } from '../../src/game/levelgen/level'
import type { Entity } from '../../src/game/entity'

const SEEDS = Number(process.argv[2] ?? 60)
const FLOORS = (process.argv[3] ?? '3,4').split(',').map(Number)

const isSealed = (d: Entity): boolean =>
  !!d.door && !d.dead && !d.door.open && (d.door.overgrown === true || (d.door.locked && (d.door.sealKind === 'keycard' || d.door.sealKind === 'power')))

const reachable = (w: World): Uint8Array => {
  const { w: W, h: H } = w.level
  const walls = new Set<number>()
  for (const e of w.entities) if (isSealed(e)) walls.add(Math.floor(e.pos.y) * W + Math.floor(e.pos.x))
  const links = new Map<number, number>()
  for (const l of w.level.stairs ?? []) links.set(l.from.y * W + l.from.x, l.landing.y * W + l.landing.x)
  const seen = new Uint8Array(W * H)
  const start = Math.floor(w.level.spawn.y) * W + Math.floor(w.level.spawn.x)
  seen[start] = 1
  const queue = [start]
  while (queue.length > 0) {
    const k = queue.pop()!
    const x = k % W
    const y = (k - x) / W
    const next = [k + 1, k - 1, k + W, k - W]
    if (x === W - 1) next[0] = -1
    if (x === 0) next[1] = -1
    const hop = links.get(k)
    if (hop !== undefined) next.push(hop)
    for (const n of next) {
      if (n < 0 || n >= W * H || seen[n]) continue
      if (isSolidTile(w.level, n % W, Math.floor(n / W)) || walls.has(n)) continue
      seen[n] = 1
      queue.push(n)
    }
  }
  return seen
}

const keyOf = (w: World, gate: Entity): Entity | undefined => {
  const d = gate.door!
  if (d.overgrown) return d.nodeId !== undefined ? w.byId.get(d.nodeId) : undefined
  if (d.sealKind === 'keycard') return w.entities.find((e) => e.pickup?.itemId === d.keyId)
  if (d.sealKind === 'power') return w.entities.find((e) => e.wing === d.wing && !e.door)
  return undefined
}

const at = (seen: Uint8Array, w: World, e: Entity | undefined): boolean =>
  !!e && seen[Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)] === 1

for (const floor of FLOORS) {
  let gated = 0
  let keyOk = 0
  let targetOk = 0
  let breachOnly = 0
  let noKey = 0
  const kinds: Record<string, number> = {}
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    const gate = w.entities.find(isSealed)
    if (!gate) continue
    gated++
    const kind = gate.door!.overgrown ? 'overgrown' : gate.door!.sealKind!
    kinds[kind] = (kinds[kind] ?? 0) + 1
    const seen = reachable(w)
    const key = keyOf(w, gate)
    if (!key) noKey++
    const k = at(seen, w, key)
    const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
    const t = at(seen, w, target)
    if (k) keyOk++
    if (t) targetOk++
    if (!k && !t) breachOnly++
  }
  console.log(
    `floor ${floor}: ${gated}/${SEEDS} gated (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}) | ` +
      `key reachable ${keyOk} | target reachable ${targetOk} | key+target breach-only ${breachOnly}/${SEEDS} | no key placed ${noKey}`,
  )
}
