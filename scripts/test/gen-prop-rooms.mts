// Prop art IN A ROOM. A lineup is not how anyone sees these sprites: a prop can
// read perfectly in isolation and fall apart on the floor tint, at game zoom,
// beside a crate and five other objects. These fixtures put the props into a
// REAL building interior -- generated walls, generated floor, real room rect --
// and arrange them deliberately rather than hunting for a seed that happens to
// furnish well.
//
// The level itself is never touched (the checksum guard forbids carving, and is
// right to): we find a real room, clear whatever populate put in it, and place
// exactly the cast of props under test.
//
//   pnpm exec tsx scripts/test/gen-prop-rooms.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { populateWorld } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { Tile, type Building } from '../../src/game/levelgen/level'
import { createWorld, type World } from '../../src/game/world'
import type { Annotation } from '../../src/game/types'

const OUT = process.argv[2] ?? 'e2e/output/prop-rooms'
mkdirSync(OUT, { recursive: true })

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

interface Room { x: number; y: number; w: number; h: number }

/** First building over a seed sweep owning a room at least `rw` x `rh`. */
const findRoom = (rw: number, rh: number): { w: World; b: Building; r: Room } => {
  for (let seed = 1; seed <= 120; seed++) {
    for (let floor = 1; floor <= 4; floor++) {
      const w = buildFloor(seed, floor)
      for (const b of w.level.buildings) {
        for (const r of b.rooms as Room[]) {
          if (r.w >= rw && r.h >= rh) return { w, b, r }
        }
      }
    }
  }
  throw new Error(`no room >= ${rw}x${rh}`)
}

/** Every Floor tile inside a room rect, in reading order. */
const floorTiles = (w: World, r: Room): { x: number; y: number }[] => {
  const out: { x: number; y: number }[] = []
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (w.level.tiles[y * w.level.w + x] === Tile.Floor) out.push({ x, y })
  return out
}

/** Drop everything populate put inside this building -- NPCs, loot and props.
 * The scene under test is the arrangement we place, not the generator's. */
const clearBuilding = (w: World, b: Building): void => {
  const inside = (e: { pos: { x: number; y: number } }): boolean =>
    e.pos.x >= b.rect.x && e.pos.x <= b.rect.x + b.rect.w &&
    e.pos.y >= b.rect.y && e.pos.y <= b.rect.y + b.rect.h
  w.entities = w.entities.filter((e) => e.playerCtl || !inside(e))
  w.byId = new Map(w.entities.map((e) => [e.id, e]))
}

/** Place `plan` on the room's floor tiles: [dx, dy] offsets from the room origin. */
const furnish = (w: World, r: Room, plan: [string, number, number][]): Annotation[] => {
  const free = new Set(floorTiles(w, r).map((t) => `${t.x},${t.y}`))
  const notes: Annotation[] = []
  for (const [arch, dx, dy] of plan) {
    const x = r.x + dx
    const y = r.y + dy
    if (!free.has(`${x},${y}`)) continue
    free.delete(`${x},${y}`)
    spawnObject(w, arch, x, y)
  }
  return notes
}

const write = (name: string, w: World, r: Room, notes: Annotation[]): void => {
  w.annotations = notes.map((n, i) => ({ ...n, id: `${name}-${i}` }))
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(serializeWorld(w)))
  const props = w.entities.filter((e) => e.kind === 'interactable' && !e.dead &&
    e.pos.x >= r.x && e.pos.x <= r.x + r.w && e.pos.y >= r.y && e.pos.y <= r.y + r.h)
  const tally: Record<string, number> = {}
  for (const e of props) tally[e.archetype] = (tally[e.archetype] ?? 0) + 1
  console.log(`${name}: room ${r.w}x${r.h} @(${r.x},${r.y})  ${props.length} props  ` +
    Object.entries(tally).map(([k, v]) => `${k}x${v}`).join(' '))
}

/** Park the player on a named tile so the camera frames the room the same way
 * in every pack -- the comparison is worthless if the camera moves. */
const park = (w: World, x: number, y: number): void => {
  const p = w.entities.find((e) => e.playerCtl)
  if (p) {
    p.pos.x = x + 0.5; p.pos.y = y + 0.5
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y
  } else spawnPlayer(w, 0, x + 0.5, y + 0.5)
}

// ---------------------------------------------------------------------------
// 1. CREW QUARTERS -- the five archetypes that have never had art (shelf, chair,
//    bunk, bench, table) arranged among three that always did (crate, cabinet,
//    barrel). Shot once per theme pack: swampspace renders the five as engine
//    vectors, each _review-* pack renders a different candidate. Same room, same
//    tiles, same neighbours, same camera -- only the sprite changes.
{
  const { w, b, r } = findRoom(9, 7)
  clearBuilding(w, b)
  const plan: [string, number, number][] = [
    ['shelf', 1, 1], ['shelf', 2, 1], ['cabinet', 3, 1], ['crate', 5, 1], ['barrel', 6, 1],
    ['bunk', 1, 3], ['bunk', 1, 5],
    ['table', 4, 3], ['chair', 3, 3], ['chair', 5, 3], ['chair', 4, 4],
    ['bench', 4, 5], ['bench', 5, 5],
  ]
  const notes = furnish(w, r, plan)
  park(w, r.x + 8, r.y + 3)
  write('crew-quarters', w, r, notes)
}

// 2. THE THREE BROKEN PROPS beside four that work. vending/toilet/atm are still
//    the old anything-xl output; this is them in a room next to cargo-crate,
//    supply-cabinet, work-desk and wall-screen rather than isolated at 6x.
{
  const { w, b, r } = findRoom(9, 7)
  clearBuilding(w, b)
  const plan: [string, number, number][] = [
    ['vending', 1, 1], ['toilet', 3, 1], ['cryoTerminal', 5, 1],
    ['crate', 1, 4], ['cabinet', 3, 4], ['desk', 5, 4], ['tv', 6, 1],
  ]
  const notes = furnish(w, r, plan)
  park(w, r.x + 8, r.y + 3)
  write('old-vs-new', w, r, notes)
}

// 3. AN UNTOUCHED APARTMENT. Nothing cleared, nothing placed -- exactly what the
//    room planner produces today. This is the honest answer to "51% of
//    furnishings are not art": a real interior, as generated.
{
  const { w, r } = findRoom(8, 6)
  const p = w.entities.find((e) => e.playerCtl)
  if (!p) spawnPlayer(w, 0, r.x + r.w / 2, r.y + r.h / 2)
  else park(w, r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2))
  write('as-generated', w, r, [])
}
console.log(`prop-room fixtures in ${OUT}`)
