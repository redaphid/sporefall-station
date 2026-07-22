// Build the exact-world snapshots behind the rooms-make-sense tour video
// (e2e/rooms-tour.mjs): populated floors with the player parked inside a
// building of each flavour — apartment, shop, office, bunker — every room
// labelled with its assigned RoomType and signature furnishings pinned, so the
// video shows rooms READING as what they are (bunks in the bedroom, the toilet
// in the bathroom corner, shelving on the shop floor, lockers in the armory).
// Deterministic: fixed seed sweep through the real createWorld/populate path.
//
//   pnpm exec tsx scripts/test/gen-rooms-tour.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { Tile, buildingAt, type Building } from '../../src/game/levelgen/level'
import { roomOwningTile } from '../../src/game/levelgen/roomTypes'
import { createWorld, type World } from '../../src/game/world'
import type { Annotation } from '../../src/game/types'

const OUT = process.argv[2] ?? 'e2e/output/rooms-fixtures'
mkdirSync(OUT, { recursive: true })

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

/** First building (over a fixed seed/floor sweep) matching `pred`. */
const findBuilding = (pred: (b: Building, w: World) => boolean): { w: World; b: Building } => {
  for (let seed = 1; seed <= 60; seed++) {
    for (let floor = 1; floor <= 5; floor++) {
      const w = buildFloor(seed, floor)
      const b = w.level.buildings.find((bb) => pred(bb, w))
      if (b) return { w, b }
    }
  }
  throw new Error('no building matched the sweep')
}

/** A free Floor tile in the building's largest room to park the player on. */
const standTile = (w: World, b: Building): { x: number; y: number } => {
  const rooms = [...b.rooms].sort((a, c) => c.w * c.h - a.w * a.h)
  const taken = new Set(
    w.entities.filter((e) => !e.dead && e.kind !== 'pickup').map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`),
  )
  for (const r of rooms) {
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        if (w.level.tiles[ty * w.level.w + tx] === Tile.Floor && !taken.has(`${tx},${ty}`)) return { x: tx, y: ty }
      }
    }
  }
  throw new Error('no free floor tile in building')
}

const ROOM_COLORS: Record<string, string> = {
  shopfloor: '#ffd24a', stockroom: '#c8a06a', living: '#8aff8a', bedroom: '#7fd1ff',
  bathroom: '#b0e8ff', lobby: '#ffd24a', office: '#7fd1ff', storage: '#c8a06a',
  waiting: '#ffd24a', ward: '#8aff8a', supply: '#c8a06a', guardpost: '#ff8a4a',
  armory: '#ff5a5a', barracks: '#7fd1ff', vault: '#ff7fd1',
}
const SIGNATURE = new Set(['toilet', 'bunk', 'shelf', 'locker', 'atm', 'desk', 'bench', 'tv', 'vending'])

/** Label every room with its type; pin one of each signature prop found. */
const annotate = (w: World, b: Building): Annotation[] => {
  const notes: Annotation[] = []
  b.rooms.forEach((r, ri) => {
    const type = b.roomTypes![ri]
    notes.push({
      id: 0, kind: 'label', x: r.x + r.w / 2, y: r.y + 0.35,
      text: type.toUpperCase(), color: ROOM_COLORS[type] ?? '#ffffff',
    })
  })
  const pinned = new Set<string>()
  for (const e of w.entities) {
    if (e.kind !== 'interactable' || !SIGNATURE.has(e.archetype) || pinned.has(e.archetype)) continue
    if (buildingAt(w.level, e.pos.x, e.pos.y) !== w.level.buildings.indexOf(b)) continue
    const ri = roomOwningTile(b.rooms, Math.floor(e.pos.x), Math.floor(e.pos.y))
    if (ri < 0) continue
    pinned.add(e.archetype)
    notes.push({ id: 0, kind: 'pin', x: e.pos.x, y: e.pos.y, text: e.archetype, color: ROOM_COLORS[b.roomTypes![ri]] ?? '#ffffff' })
  }
  return notes
}

const write = (name: string, w: World, b: Building): void => {
  const spot = standTile(w, b)
  const player = w.entities.find((e) => e.playerCtl)
  if (player) {
    player.pos.x = spot.x + 0.5
    player.pos.y = spot.y + 0.5
    player.prevPos.x = player.pos.x
    player.prevPos.y = player.pos.y
  } else {
    spawnPlayer(w, 0, spot.x + 0.5, spot.y + 0.5)
  }
  const notes = annotate(w, b)
  w.annotations = notes.map((n, i) => ({ ...n, id: `rooms-${i}` }))
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(serializeWorld(w)))
  console.log(`${name}: ${b.role} at (${b.rect.x},${b.rect.y}) rooms=[${b.roomTypes!.join(',')}] ${notes.length} labels`)
}

const has = (b: Building, t: string): boolean => (b.roomTypes ?? []).includes(t as never)

// An apartment that shows the full flat anatomy: living + bedroom + bathroom.
{
  const { w, b } = findBuilding((bb) => bb.role === 'apartment' && has(bb, 'bathroom') && has(bb, 'bedroom') && bb.rooms.length >= 3)
  write('rooms-1-apartment', w, b)
}
// A shop with front-of-house AND back stock.
{
  const { w, b } = findBuilding((bb) => bb.role === 'shop' && has(bb, 'shopfloor') && has(bb, 'stockroom'))
  write('rooms-2-shop', w, b)
}
// An office with lobby, workrooms and a storage closet.
{
  const { w, b } = findBuilding((bb) => bb.role === 'office' && has(bb, 'lobby') && has(bb, 'storage'))
  write('rooms-3-office', w, b)
}
// A bunker: guard band around the locker-filled armory core.
{
  const { w, b } = findBuilding((bb) => bb.role === 'bunker' && has(bb, 'armory'))
  write('rooms-4-bunker', w, b)
}
console.log(`rooms fixtures in ${OUT}`)
