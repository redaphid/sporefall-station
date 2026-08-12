import { WEAPONS } from './data/items'
import { NPCS } from './data/npcs'
import { makeEntity, type Entity, type ItemStack, type Loadout, type WeaponMod } from './entity'
import { bunkerLaneKeys, isSolidTile, isWallTile, Tile, tileAt, type Building, type RoomType } from './levelgen/level'
import { groupProps, planRoom, PROP_PLACEMENT, ROOM_LAYOUT, type FreeTile, type Placement } from './levelgen/furnish'
import { assignRoomTypes, roomOwningTile } from './levelgen/roomTypes'
import type { Rect } from './levelgen/rooms'

// Re-exported from its levelgen home so existing consumers/tests keep working.
export { roomOwningTile }
import type { Rng } from './rng'
import { weightedModId } from './systems/draft'
import { spawnObject } from './systems/objects'
import { addEntity, type World } from './world'

/** Roughly this fraction of interior rooms sprinkle a weapon-mod pickup, so mods
 * turn up during exploration (#53 draft aside) at about 1-in-3 rooms. Tunable. */
export const MOD_PICKUP_ROOM_CHANCE = 1 / 3

/** No street-life NPC (or street patrol waypoint) may be placed closer than this
 * to the player spawn. Sized past the LONGEST NPC sight range (8) so that with
 * `world.hostile` (every NPC engages players on sight) nobody can already see —
 * and beeline for — the spawn tile on tick 0. Before this guard, ~8% of seeds
 * beat an idle just-spawned player to death within 10 seconds (seed 7 among
 * them: a bat civilian 2.2 tiles from spawn). Building interiors are exempt —
 * walls block sight, and the door is the player's choice to open. */
export const SPAWN_SAFE_RADIUS = 9

/** A weighted arsenal every populated NPC draws from, so a floor fields a fun
 * SPREAD of weapons rather than one archetype-locked stick. Common melee/pistol
 * dominate; heavy and elemental guns are the rarer spice (so freeze/fire/shock
 * turn up but don't blanket the floor). Drawn from a DEDICATED `npc-weapons` fork
 * (see populateWorld) so weapon rolls never perturb the loot/position stream —
 * same seed → same layout, whatever the arsenal does. */
const NPC_ARSENAL: [string, number][] = [
  ['knife', 5],
  ['bat', 5],
  ['pistol', 5],
  ['shotgun', 2],
  ['machinegun', 2],
  ['sledgehammer', 1],
  ['freezeRay', 1],
  ['flamethrower', 1],
  ['stunGun', 1],
]
const ARSENAL_TOTAL = NPC_ARSENAL.reduce((s, [, wt]) => s + wt, 0)

/** Weighted pick from the arsenal — a fully deterministic function of `rng`. */
const rollWeapon = (rng: Rng): string => {
  let roll = rng.int(1, ARSENAL_TOTAL)
  for (const [id, wt] of NPC_ARSENAL) {
    roll -= wt
    if (roll <= 0) return id
  }
  return NPC_ARSENAL[0][0]
}

/** Weapon-mods an enemy can spawn WIELDING — the tactically-loud ones, so a
 * modded foe reads as a distinct threat that demands different play: punch
 * through your cover (pierce), blow up on impact (explosive), out-DPS you
 * (rapid), freeze/ignite you (frost/incendiary), or chase you round a corner
 * (homing). This is the "build matters" payoff — a modded enemy's shots fold its
 * mods into the projectile at the shared fire site exactly like a player's. */
const ENEMY_MODS: [string, number][] = [
  ['pierce', 4],
  ['explosive', 3],
  ['rapid', 3],
  ['frost', 2],
  ['incendiary', 2],
  ['homing', 1],
]
const ENEMY_MOD_TOTAL = ENEMY_MODS.reduce((s, [, wt]) => s + wt, 0)

const weightedEnemyMod = (rng: Rng): string => {
  let roll = rng.int(1, ENEMY_MOD_TOTAL)
  for (const [id, wt] of ENEMY_MODS) {
    roll -= wt
    if (roll <= 0) return id
  }
  return ENEMY_MODS[0][0]
}

/** Deterministically hand a fraction of the floor's ARMED, ranged enemies a
 * single weapon-mod, so a run fields the odd tactically-distinct foe (a pierce
 * shooter that ignores your cover, an explosive one you can't crowd). Only ranged
 * loadouts qualify — a mod has to fold into a PROJECTILE to be legible — and a
 * fists/melee enemy is skipped WITHOUT drawing, so the roll stream stays a pure
 * function of which enemies happen to carry guns. Floor-scaled (8%/gun on floor 1
 * up to a 40% cap) so early floors stay gentle and depth turns up the heat but
 * never blankets it. Runs as a POST-PASS over the spawned entities (id order) on
 * a DEDICATED `npc-mods` fork so it perturbs neither the layout/loot dice nor the
 * weapon-assignment stream — same seed+floor → the same enemies carry the same
 * mods, on every peer and every replay. */
const armModdedEnemies = (w: World): void => {
  const rng = w.rng.fork('npc-mods')
  const pMod = Math.min(0.4, 0.08 * w.floor)
  for (const e of w.entities) {
    if (e.kind !== 'npc' || !e.loadout || !e.combat) continue
    if (WEAPONS[e.combat.weapon]?.kind !== 'ranged') continue // a mod only reads folded into a bullet
    if (!rng.chance(pMod)) continue
    const stack = e.loadout.inventory[e.loadout.activeSlot]
    if (!stack) continue
    ;(stack.mods ??= []).push({ id: weightedEnemyMod(rng), stacks: 1 })
  }
}

/** Host-only: fill a freshly generated level with NPCs and loot. */
export const populateWorld = (w: World): void => {
  const rng = w.rng.fork('populate')
  // Weapon assignment rides its OWN stream so it can vary the arsenal without
  // shifting the loot/position dice — layout stays bit-identical per seed.
  const wrng = w.rng.fork('npc-weapons')
  for (let i = 0; i < w.level.buildings.length; i++) {
    populateBuilding(w, rng, wrng, w.level.buildings[i], i)
  }
  spawnStreetLife(w, rng, wrng)
  sprinkleLoot(w, rng)
  scatterModPickups(w)
  // #78 follow-up: seed the resist-differentiated Sporefall roster into normal
  // encounters on its OWN rng fork, so the loot/position/weapon dice above stay
  // byte-identical per seed — only the entity list grows.
  spawnEncounters(w, w.rng.fork('encounters'))
  // #78 payoff: once every enemy carries a real, moddable loadout, hand some of
  // the armed ones a weapon-mod so "build matters" cuts both ways — on its own
  // `npc-mods` fork, so it never disturbs the layout/loot/weapon streams above.
  armModdedEnemies(w)
  furnishInteriors(w)
  // Tactical-AI post-passes, each on its OWN fork so every stream above stays
  // byte-identical per seed (the existing populate tests are the proof):
  // a bunker defender turns barricader, then gangster packs become squads
  // (in that order, so a squad never conscripts the barricader), and deep
  // floors seed dormant corner-ambushers into back rooms.
  assignBarricaders(w)
  assignSquads(w)
  spawnLurkers(w)
}

/** Room types a lurker haunts — dark back-of-house corners, never the front. */
const LURKER_ROOMS: readonly RoomType[] = ['stockroom', 'guardpost', 'bathroom', 'storage']

/** Seed dormant lurkers (the jump-scare ambusher, data/npcs.ts) sparingly into
 * preferred back rooms — deeper floors haunt more, floor 1 stays clean. Own
 * `lurkers` fork appended AFTER every other stream, so existing populate
 * output is byte-identical per seed; only the entity list grows. The bunker
 * BAND room (the patrol lane's room) is exempt so a parked body never sits on
 * a promised-open beat. */
const spawnLurkers = (w: World): void => {
  if (w.floor < 2) return
  const rng = w.rng.fork('lurkers')
  for (let bi = 0; bi < w.level.buildings.length; bi++) {
    const b = w.level.buildings[bi]
    const p = Math.min(0.5, 0.1 + 0.08 * w.floor)
    if (!rng.chance(p)) continue
    const types = b.roomTypes ?? assignRoomTypes(b)
    const rooms: number[] = []
    for (let ri = 0; ri < b.rooms.length; ri++) {
      if (b.role === 'bunker' && ri === 0) continue // never the guard band
      if (LURKER_ROOMS.includes(types[ri])) rooms.push(ri)
    }
    if (rooms.length === 0) continue // no dark corner here — sparse is fine
    const ri = rooms[rng.int(0, rooms.length - 1)]
    const spot = lurkerHideTile(w, b, ri)
    if (!spot) continue
    const lurker = spawnNpc(w, 'lurker', spot.x + 0.5, spot.y + 0.5)
    lurker.ai!.zone = { building: bi, role: b.role }
    // A woken lurker that loses its prey stays parked in its corner (guard),
    // keeping the ambush pocket armed instead of ambling into the open.
    lurker.ai!.guard = true
  }
}

/** The room's best hiding tile: wall-hugging, as far from every door as the
 * room allows, free of furniture and reserved tiles. Deterministic argmax in
 * row-major order (strictly-greater wins), or null for a bare/hostile room. */
const lurkerHideTile = (w: World, b: Building, ri: number): { x: number; y: number } | null => {
  const room = b.rooms[ri]
  const lw = w.level.w
  const spawnTx = Math.floor(w.level.spawn.x)
  const spawnTy = Math.floor(w.level.spawn.y)
  const exitTx = Math.floor(w.level.exit.x)
  const exitTy = Math.floor(w.level.exit.y)
  const taken = new Set<number>()
  for (const e of w.entities) {
    if (e.kind === 'interactable' && !e.dead) taken.add(Math.floor(e.pos.y) * lw + Math.floor(e.pos.x))
  }
  let best: { x: number; y: number } | null = null
  let bestScore = -Infinity
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      if (w.level.tiles[ty * lw + tx] !== Tile.Floor) continue
      if (roomOwningTile(b.rooms, tx, ty) !== ri) continue
      if (taken.has(ty * lw + tx)) continue
      if (tx === spawnTx && ty === spawnTy) continue
      if (tx === exitTx && ty === exitTy) continue
      const walls = wallNeighbours(w, tx, ty)
      if (walls === 0) continue // it hides AGAINST something, never mid-floor
      let dmin = Infinity
      for (const d of b.doors) dmin = Math.min(dmin, Math.hypot(d.x - tx, d.y - ty))
      const score = dmin + walls * 0.25 // far from doors first, cornered second
      if (score > bestScore) {
        bestScore = score
        best = { x: tx, y: ty }
      }
    }
  }
  return best
}

/** Chance a bunker fields a barricader among its defenders. */
const BARRICADER_CHANCE = 0.75

/** One defender per bunker (chance-gated) becomes a 'barricader' — it plugs
 * the garrison's doorway approaches with junk barricades, then guards. Runs
 * on a DEDICATED `barricaders` fork over already-spawned entities in id
 * order; no other stream moves. Patrol beats keep their brains. */
const assignBarricaders = (w: World): void => {
  const rng = w.rng.fork('barricaders')
  for (let bi = 0; bi < w.level.buildings.length; bi++) {
    const b = w.level.buildings[bi]
    if (b.role !== 'bunker') continue
    const pack = w.entities.filter(
      (e) =>
        e.kind === 'npc' &&
        (e.archetype === 'thug' || e.archetype === 'gangster') &&
        e.ai?.zone?.building === bi &&
        e.ai.behavior !== 'patrol',
    )
    if (pack.length === 0) continue
    if (!rng.chance(BARRICADER_CHANCE)) continue
    pack[pack.length - 1].ai!.behavior = 'barricader' // the last-spawned defender takes the job
  }
}

/** Squad size cap: lead + flank + rears. */
export const SQUAD_MAX = 4
/** Chance an eligible gang pack actually forms up (some stay a loose rabble). */
const SQUAD_CHANCE = 0.85

/** Link each warehouse/bunker's role-spawned gang pack (thugs/gangsters bound
 * to that building) into a `squad` (behaviors.ts): first member leads, second
 * flanks, the rest stack rear. Post-pass over spawned entities in id order on a
 * DEDICATED `squads` fork — no other stream moves. Patrol beats (the
 * promised-open-lane contract) and barricaders keep their brains. */
const assignSquads = (w: World): void => {
  const rng = w.rng.fork('squads')
  let nextSquad = 1
  for (let bi = 0; bi < w.level.buildings.length; bi++) {
    const b = w.level.buildings[bi]
    if (b.role !== 'warehouse' && b.role !== 'bunker') continue
    const pack = w.entities.filter(
      (e) =>
        e.kind === 'npc' &&
        (e.archetype === 'thug' || e.archetype === 'gangster') &&
        e.ai?.zone?.building === bi &&
        e.ai.behavior !== 'patrol' &&
        e.ai.behavior !== 'barricader',
    )
    if (pack.length < 2) continue
    if (!rng.chance(SQUAD_CHANCE)) continue
    const id = nextSquad++
    pack.slice(0, SQUAD_MAX).forEach((m, i) => {
      m.ai!.behavior = 'squad'
      m.ai!.squad = { id, role: i === 0 ? 'lead' : i === 1 ? 'flank' : 'rear' }
    })
  }
}

/** Which props a room type can hold, DERIVED from how that room type is laid
 * out (`ROOM_LAYOUT` in levelgen/furnish.ts — the recipes are the source of
 * truth now, so the palette can never drift out of sync with what is actually
 * placed). Kept exported because tests, the rooms-tour fixture generator and
 * mission code all ask "what belongs in a room of this type?".
 *
 * A room still reads as WHAT IT IS at a glance — a bedroom holds bunks, a
 * bathroom its toilet, a shop floor its shelves and till, an armory its weapon
 * lockers — but the ARRANGEMENT of those props is what stops it looking like
 * scattered junk, and that lives in ROOM_LAYOUT. Everything here is a soft,
 * destructible object — never a solid tile — so it can't wall off a room, block
 * reachability, or trap an occupant. */
const derivePalettes = (): Record<RoomType, readonly string[]> => {
  const out = {} as Record<RoomType, readonly string[]>
  for (const type of Object.keys(ROOM_LAYOUT) as RoomType[]) out[type] = groupProps(ROOM_LAYOUT[type])
  return out
}
export const ROOM_FURNISH: Record<RoomType, readonly string[]> = derivePalettes()

export { PROP_PLACEMENT }

/** Hard ceiling on furnishings per room, so a big open hall gets a believable
 * few — not two dozen crates packed shoulder to shoulder. */
export const FURNISH_MAX_PER_ROOM = 6

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

/** How many of a tile's 4 orthogonal neighbours are wall tiles — 0 means open
 * floor mid-room, 1 means against a wall, 2+ means tucked into a corner. */
const wallNeighbours = (w: World, tx: number, ty: number): number => {
  let count = 0
  for (const [dx, dy] of ORTHO) if (isWallTile(tileAt(w.level, tx + dx, ty + dy))) count++
  return count
}

/** Deterministically furnish every building interior with ROOM-TYPE-appropriate
 * props, ARRANGED the way a room of that type actually would be: the stockroom's
 * shelving ranked down one wall with the crates heaped in a corner, the office's
 * desks in a row each with its chair pulled up, the living room's seats drawn up
 * facing the screen, the bathroom's toilet tucked in a corner.
 *
 * The arrangement itself is `planRoom` (levelgen/furnish.ts); this pass decides
 * WHICH TILES are eligible and how many props a room may hold, then spawns what
 * the planner decided. Runs on a DEDICATED `furnish` fork so it neither perturbs
 * nor is perturbed by the loot/AI/mod streams — same seed+floor → the same
 * furniture on every peer.
 *
 * Placement leaves every doorway (and the tile just inside it), the player spawn
 * tile and the exit tile clear, never stacks two props on one tile, and caps
 * density at ~¼ of a room's free floor so rooms stay walkable — even degenerate
 * 2×2 vaults and closets. `populate.reachability.test.ts` proves the stronger
 * property the arrangement work put at risk: even treating every prop as if it
 * were solid, every doorway, room and objective stays reachable. */
const furnishInteriors = (w: World): void => {
  const rng = w.rng.fork('furnish')
  const lw = w.level.w
  const spawnTx = Math.floor(w.level.spawn.x)
  const spawnTy = Math.floor(w.level.spawn.y)
  const exitTx = Math.floor(w.level.exit.x)
  const exitTy = Math.floor(w.level.exit.y)
  // Keep EVERY doorway on the floor (and the tile immediately inside it) clear,
  // not just the doorways of the building being furnished. Buildings share walls
  // and hallway spines, so a room of building A can perfectly well contain the
  // tile just inside building B's door — and when this set was built per-building
  // that neighbour's doorway got plugged. Level-wide is the whole fix.
  const keepClear = new Set<number>()
  for (const b of w.level.buildings) {
    for (const d of b.doors) {
      keepClear.add(d.y * lw + d.x)
      for (const [dx, dy] of ORTHO) keepClear.add((d.y + dy) * lw + (d.x + dx))
    }
    // The bunker guard's beat circuits the band's inner ring (patrolBeat) as
    // straight legs — that lane is a promised-open contract, so furniture (a
    // soft body that shoves movers) never sits on it. Shared with the fortify
    // behavior so runtime barricades honor the same lane (bunkerLaneKeys).
    for (const k of bunkerLaneKeys(b, lw)) keepClear.add(k)
  }
  // Plan every room first, then commit the whole floor through the circulation
  // guard below — a placement is only safe in the context of every OTHER prop.
  const planned: Placement[] = []
  for (const building of w.level.buildings) {
    // generateLevel always fills roomTypes; the fallback covers hand-built
    // Buildings in tests/scenarios (assignRoomTypes is pure and rng-free).
    const types = building.roomTypes ?? assignRoomTypes(building)
    for (let ri = 0; ri < building.rooms.length; ri++) {
      const room = building.rooms[ri]
      // Collect the room's free interior floor tiles (never a wall, doorway,
      // door-adjacent, spawn or exit tile — and only tiles this room OWNS, so a
      // nested vault chamber isn't furnished twice as part of its outer hall).
      const free: FreeTile[] = []
      for (let ty = room.y; ty < room.y + room.h; ty++) {
        for (let tx = room.x; tx < room.x + room.w; tx++) {
          if (w.level.tiles[ty * lw + tx] !== Tile.Floor) continue
          if (keepClear.has(ty * lw + tx)) continue
          if (tx === spawnTx && ty === spawnTy) continue
          if (tx === exitTx && ty === exitTy) continue
          if (roomOwningTile(building.rooms, tx, ty) !== ri) continue
          free.push({ x: tx, y: ty, walls: wallNeighbours(w, tx, ty) })
        }
      }
      // A closet with fewer than two free tiles stays bare — nowhere to stand
      // otherwise. Everything roomier gets at least one furnishing.
      if (free.length < 2) continue
      const n = Math.min(FURNISH_MAX_PER_ROOM, Math.max(1, Math.floor(free.length / 4)))
      // Plan the whole room as related GROUPS (levelgen/furnish.ts).
      const plan = planRoom(free, lw, (x, y) => isWallTile(tileAt(w.level, x, y)), ROOM_LAYOUT[types[ri]], n, rng)
      for (const p of plan) planned.push(p)
    }
  }
  commitFurniture(w, planned)
}

/**
 * Commit planned furniture, refusing any single piece that would cut the floor.
 *
 * Arranging props into ranks and clumps is exactly what makes a layout pass
 * capable of building a WALL out of furniture: a rank across a narrow room, a
 * heap of crates grown over a three-wide passage. Props are soft bodies (a
 * player shoves through one), so this was never fatal — but "you can barge
 * through it" is a poor answer to "that room looks sealed", and the hazard is
 * not new: the old scattered placement violated the same property on seed 1,
 * floor 1 (see populate.reachability.test.ts, which fails on both).
 *
 * So each piece is admitted only if, treating every already-admitted prop as
 * SOLID, it leaves every still-reachable tile reachable — and can itself be
 * walked up to. Pieces are considered in plan order, so a room's first
 * (signature) piece is judged against an almost-empty floor and effectively
 * always lands; only the marginal piece that would seal something is dropped.
 * Deterministic: it draws no rng at all, so same seed → same admissions.
 *
 * COST. The obvious implementation — re-flood the whole floor per piece — is
 * correct and made level generation ~64× slower (1.2ms → 74ms per floor), which
 * a phone pays at every floor transition. Almost every piece is decided instead
 * by a LOCAL cut-vertex test on the eight tiles around it: if all of its open
 * orthogonal neighbours sit in one connected arc of that ring, they can still
 * reach each other around the piece, so removing the tile cannot disconnect
 * anything and no flood is needed. Only the genuinely ambiguous piece (its
 * neighbours split into separate arcs — a doorway, a corridor pinch) pays for a
 * flood. Same admissions, a fraction of the work.
 */
const commitFurniture = (w: World, planned: readonly Placement[]): void => {
  const lw = w.level.w
  const lh = w.level.h
  const blocked = new Set<number>()
  const startX = Math.floor(w.level.spawn.x)
  const startY = Math.floor(w.level.spawn.y)
  /** Tiles reachable from the player spawn, treating `blocked` as solid. */
  const reachable = (): Set<number> => {
    const seen = new Set<number>()
    const open = (tx: number, ty: number): boolean =>
      tx >= 0 && ty >= 0 && tx < lw && ty < lh && !isSolidTile(w.level, tx, ty) && !blocked.has(ty * lw + tx)
    if (!open(startX, startY)) return seen
    const stack = [startY * lw + startX]
    seen.add(stack[0])
    while (stack.length > 0) {
      const k = stack.pop()!
      const tx = k % lw
      const ty = (k - tx) / lw
      for (const [dx, dy] of ORTHO) {
        const nk = (ty + dy) * lw + (tx + dx)
        if (seen.has(nk) || !open(tx + dx, ty + dy)) continue
        seen.add(nk)
        stack.push(nk)
      }
    }
    return seen
  }
  const walkable = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < lw && ty < lh && !isSolidTile(w.level, tx, ty) && !blocked.has(ty * lw + tx)
  /** Can a player stand next to the prop on `key` and act on it? */
  const approachable = (key: number, reach: ReadonlySet<number>): boolean => {
    const tx = key % lw
    const ty = (key - tx) / lw
    return ORTHO.some(([dx, dy]) => reach.has((ty + dy) * lw + (tx + dx)))
  }
  // The 8 ring offsets in CYCLIC order, so consecutive entries are themselves
  // orthogonally adjacent — which is what lets a walk of the ring decide
  // 4-connected reachability around the middle tile. Even indices are the
  // orthogonal neighbours (N, E, S, W).
  const RING = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ] as const
  /** True when removing (tx,ty) provably cannot disconnect anything: all of its
   * open orthogonal neighbours lie in ONE connected arc of the surrounding ring,
   * so each can still reach the others by stepping around this tile. Conservative
   * — `false` only means "not provable locally", and the caller then floods. */
  const locallySafe = (tx: number, ty: number): boolean => {
    const open: boolean[] = []
    for (const [dx, dy] of RING) open.push(walkable(tx + dx, ty + dy))
    const orth = [0, 2, 4, 6].filter((i) => open[i])
    if (orth.length <= 1) return true // a leaf: nothing behind it to cut off
    if (open.every((o) => o)) return true // wide open floor
    // Label each open ring cell with the id of its cyclic arc.
    const arc: number[] = new Array<number>(8).fill(-1)
    let next = 0
    for (let i = 0; i < 8; i++) {
      if (!open[i] || arc[i] !== -1) continue
      const id = next++
      for (let k = 0; k < 8 && open[(i + k) % 8]; k++) arc[(i + k) % 8] = id
    }
    // Join the arcs that wrap across index 0.
    if (open[0] && open[7] && arc[0] !== arc[7]) {
      const from = arc[7]
      for (let i = 0; i < 8; i++) if (arc[i] === from) arc[i] = arc[0]
    }
    return orth.every((i) => arc[i] === arc[orth[0]])
  }
  let reach = reachable()
  for (const p of planned) {
    const key = p.y * lw + p.x
    // A tile the floor plan never connected to spawn in the first place is
    // levelgen's business (a sealed vault chamber); furnishing it changes nothing.
    if (!reach.has(key)) {
      spawnPlanned(w, p)
      continue
    }
    blocked.add(key)
    // `after` is the reachable set once this tile is taken. When the local test
    // proves nothing can be cut off, that is exactly `reach` minus this tile —
    // no flood required.
    let after: Set<number>
    if (locallySafe(p.x, p.y)) {
      after = reach
      after.delete(key)
    } else {
      after = reachable()
      if (after.size !== reach.size - 1) {
        blocked.delete(key) // this piece would seal something off — leave it bare
        continue
      }
    }
    // It must be possible to walk up to the piece (to smash, loot or use it) —
    // and it must not fence in a piece already standing beside it, because a
    // later prop can steal the ONLY reachable neighbour an earlier one had.
    let safe = approachable(key, after)
    if (safe) {
      for (const [dx, dy] of ORTHO) {
        const nk = (p.y + dy) * lw + (p.x + dx)
        if (blocked.has(nk) && nk !== key && !approachable(nk, after)) {
          safe = false
          break
        }
      }
    }
    if (!safe) {
      blocked.delete(key)
      if (after === reach) reach.add(key) // undo the in-place delete above
      continue
    }
    reach = after
    spawnPlanned(w, p)
  }
}

const spawnPlanned = (w: World, p: Placement): void => {
  const e = spawnObject(w, p.prop, p.x, p.y)
  e.facing = p.facing
  // A backed prop is drawn nudged into its wall (see render/sprites.ts), so a
  // rank of shelving kisses the wall instead of floating a half-tile off it.
  if (p.mounted) e.mount = 'wall'
}

/** #78 — inject the Sporefall threat roster (brute/cinder/sporeling/robot) into
 * normal floors so the anti-dominance matchups (burn the brute, shoot the
 * cinder, fire/bullets the swarm, fire the robot) actually come up in play.
 * Weighted by floor + theme, deterministic on its isolated `encounters` fork; no
 * weapon roll (creatures keep their signature weapon), so the npc-weapons stream
 * is untouched too. */
const spawnEncounters = (w: World, erng: Rng): void => {
  const theme = w.level.theme
  const floor = w.floor
  for (const b of w.level.buildings) {
    // Spore-vermin: a swarm that thickens with depth (and where blooms grow).
    let sporelings = 0
    if (erng.chance(floor >= 2 ? 0.45 : 0.2)) sporelings += erng.int(1, 1 + Math.min(3, floor))
    // Cinders: industrial fire-dwellers (a fireproof answer to a flame build).
    let cinders = 0
    if (theme === 'industrial' && erng.chance(0.5)) cinders += erng.int(1, 2)
    else if (erng.chance(0.12)) cinders += 1
    // Brutes: armoured spikes on deeper floors — bring fire, not bullets.
    let brutes = 0
    if (floor >= 3 && erng.chance(0.35)) brutes += 1
    else if (floor >= 2 && erng.chance(0.12)) brutes += 1
    // Derelict Units: industrial/deep — armour + bio-inert, servos cook to fire.
    let robots = 0
    if ((theme === 'industrial' || floor >= 4) && erng.chance(0.3)) robots += 1
    // Stalkers (#67): a scavenger that culls the wounded — a lone opportunist,
    // deeper floors, low count (a pack of them would just avoid each other).
    let stalkers = 0
    if (floor >= 2 && erng.chance(0.25)) stalkers += 1
    // Spore pods (#68): a dormant nest — a stealth set-piece to tiptoe past or trip.
    let pods = 0
    if (floor >= 2 && erng.chance(0.3)) pods += erng.int(2, 4)
    for (const [arch, n] of [
      ['sporeling', sporelings],
      ['cinder', cinders],
      ['brute', brutes],
      ['robot', robots],
      ['stalker', stalkers],
      ['pod', pods],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const spot = randomFloorInBuilding(w, erng, b)
        if (spot) spawnNpc(w, arch, spot.x, spot.y)
      }
    }
  }
}

const ROLE_SPAWNS: Record<Building['role'], { archetype: string; count: [number, number] }[]> = {
  shop: [
    { archetype: 'shopkeeper', count: [1, 1] },
    { archetype: 'civilian', count: [0, 1] },
  ],
  apartment: [{ archetype: 'civilian', count: [1, 3] }],
  office: [
    { archetype: 'civilian', count: [1, 2] },
    { archetype: 'cop', count: [0, 1] },
  ],
  warehouse: [{ archetype: 'thug', count: [2, 3] }],
  clinic: [{ archetype: 'civilian', count: [1, 2] }],
  // Bunkers (themed floors >= 2 only) are garrisons: always guarded.
  bunker: [
    { archetype: 'thug', count: [1, 2] },
    { archetype: 'gangster', count: [1, 2] },
  ],
}

const populateBuilding = (w: World, rng: Rng, wrng: Rng, building: Building, buildingIdx: number): void => {
  const specs = [...ROLE_SPAWNS[building.role]]
  // Difficulty ramp: deeper floors gang up
  if (w.floor >= 2 && building.role === 'warehouse') specs.push({ archetype: 'gangster', count: [1, 2] })
  if (w.floor >= 3 && building.role === 'office') specs.push({ archetype: 'gangster', count: [0, 1] })
  if (w.floor >= 2 && building.role === 'shop') specs.push({ archetype: 'bouncer', count: [1, 1] })
  for (const spec of specs) {
    const n = rng.int(spec.count[0], spec.count[1])
    for (let i = 0; i < n; i++) {
      const spot = randomFloorInBuilding(w, rng, building)
      if (!spot) continue
      // The new-archetype patrol beats (bunker band, courtyard pit) are FIXED
      // rectangles of provably-open tiles — patrol steering is straight-line
      // (no pathfinder), so the patroller spawns ON its first waypoint and
      // every leg runs along an unobstructed row/col. No rng drawn for either
      // (the position dice above are still rolled), so streams stay put.
      const beat = patrolBeat(building, spec === specs[0] && i === 0)
      const pos = beat ? beat[0] : spot
      const npc = spawnNpc(w, spec.archetype, pos.x, pos.y, wrng)
      // #77 — bind the NPC to the module it lives/works/guards in, so its brain
      // can derive territorial goals (hold its room, garrison/defend the wing).
      if (npc.ai) npc.ai.zone = { building: buildingIdx, role: building.role }
      if (beat) assignPatrol(npc, beat)
      // One thug per warehouse walks rounds through the stock instead of
      // loitering — an interior patrol the players can time and slip past.
      // (Unless a set-piece beat already claimed this NPC: a warehouse-role
      // COMPOUND's first thug walks the pit, not the stock.)
      if (!beat && building.role === 'warehouse' && spec.archetype === 'thug' && i === 0) {
        const wbeat = [{ x: spot.x, y: spot.y }]
        for (let j = 0; j < 2; j++) {
          const p = randomFloorInBuilding(w, rng, building)
          if (p) wbeat.push(p)
        }
        assignPatrol(npc, wbeat)
      }
    }
  }
  if (building.role === 'shop') stockShop(w, rng, building)
}

/** A rectangular circuit of tile-centre waypoints along `r`'s inner ring. */
const ringBeat = (r: Rect): { x: number; y: number }[] => [
  { x: r.x + 0.5, y: r.y + 0.5 },
  { x: r.x + r.w - 0.5, y: r.y + 0.5 },
  { x: r.x + r.w - 0.5, y: r.y + r.h - 0.5 },
  { x: r.x + 0.5, y: r.y + r.h - 0.5 },
]

/** The set-piece patrol circuit for this building's FIRST spawned NPC, if any.
 * Bunker: the guard band's inner ring (one tile in from the band edge — clear
 * of the airlock's flanking walls and the chamber ring, so every straight leg
 * is open). Courtyard compound: the pit's edge. Both are levelgen-guaranteed
 * open rectangles, safe for the pathless straight-line patrol steering. */
const patrolBeat = (building: Building, isFirst: boolean): { x: number; y: number }[] | null => {
  if (!isFirst) return null
  if (building.role === 'bunker') {
    const band = building.rooms[0]
    return ringBeat({ x: band.x + 1, y: band.y + 1, w: band.w - 2, h: band.h - 2 })
  }
  if (building.courtyard) return ringBeat(building.courtyard)
  return null
}

// Loot is tiered by depth: floor 1 stays basic (bat/knife/bandages), then the
// element arsenal folds in so the frost/fire/shock/sleep/poison systems come
// online as you descend. Shops always stock element gear (see stockShop), so
// the interaction combos stay reachable regardless of how the dice fall.
const BASIC_LOOT = ['bat', 'knife', 'bandage', 'bandage', 'medkit', 'cash']
const ELEMENT_THROWABLES = ['molotov', 'grenade', 'freezeGrenade', 'chloroform', 'banana', 'gasGrenade']
const ELEMENT_WEAPONS = ['freezeRay', 'tranquilizer', 'sledgehammer', 'flamethrower', 'stunGun']
const GUNS = ['shotgun', 'machinegun']

/** The floor's random-loot table: basics everywhere, element throwables and a
 * couple of element weapons from floor 2, the full arsenal from floor 3 on. */
const lootTable = (floor: number): string[] => {
  const table = [...BASIC_LOOT]
  if (floor >= 2) table.push(...ELEMENT_THROWABLES, 'freezeRay', 'sledgehammer')
  if (floor >= 3) table.push(...ELEMENT_WEAPONS, ...GUNS, ...ELEMENT_THROWABLES)
  return table
}

/** Element gear a shop can carry — the reliable place to gear up on any floor,
 * so freeze-shatter / fire-spread combos are always within reach. */
const SHOP_STOCK = [
  'freezeRay', 'tranquilizer', 'sledgehammer', 'flamethrower', 'stunGun', 'shotgun',
  'molotov', 'freezeGrenade', 'chloroform', 'gasGrenade', 'banana', 'grenade', 'medkit',
]

/** Every item id the level generator can lay on the floor as a `pickup.<id>`:
 * the deepest loot table plus everything a shop can stock. NPC weapon drops add
 * to this at runtime (see combat.ts `isDroppableWeapon`) and are unioned in by
 * the caller rather than here, so this stays a pure statement about level gen.
 *
 * Exported for `itemArtResolution.test.ts`, which asserts every one of these has
 * real art. `banana` sat in this list for its whole life with no `ITEM_ALIAS`
 * entry and silently rendered as a medkit; the test exists so the next id added
 * here cannot repeat that. Derived from the tables rather than restated, so a
 * new loot entry is covered automatically. */
export const LOOT_ITEM_IDS: readonly string[] = [...new Set([...lootTable(Number.MAX_SAFE_INTEGER), ...SHOP_STOCK])]

const dropPickup = (w: World, itemId: string, x: number, y: number, qty: number): void => {
  const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
  e.pickup = { itemId, qty }
  addEntity(w, e)
}

/** Lay out a shop's wares: a handful of element weapons/throwables on the floor
 * for the taking, so every run has somewhere to buy into the element systems. */
const stockShop = (w: World, rng: Rng, building: Building): void => {
  const n = rng.int(2, 4)
  for (let i = 0; i < n; i++) {
    const spot = randomFloorInBuilding(w, rng, building)
    if (spot) dropPickup(w, rng.pick(SHOP_STOCK), spot.x, spot.y, 1)
  }
}

const spawnStreetLife = (w: World, rng: Rng, wrng: Rng): void => {
  const wanderers = rng.int(4, 7)
  for (let i = 0; i < wanderers; i++) {
    const spot = randomStreetSpot(w, rng, Tile.Sidewalk) ?? randomStreetSpot(w, rng, Tile.Street)
    if (spot) spawnNpc(w, 'civilian', spot.x, spot.y, wrng)
  }
  // Scavengers: a couple of civ-faction gleaners drawn to loose loot, so the
  // street competes with the players for unclaimed pickups.
  const scavengers = rng.int(1, 2)
  for (let i = 0; i < scavengers; i++) {
    const spot = randomStreetSpot(w, rng, Tile.Sidewalk) ?? randomStreetSpot(w, rng, Tile.Street)
    if (spot) spawnNpc(w, 'civilian', spot.x, spot.y, wrng).ai!.behavior = 'scavenger'
  }
  const copPairs = 1 + Math.floor(w.floor / 3)
  for (let i = 0; i < copPairs; i++) {
    const spot = randomStreetSpot(w, rng, Tile.Street)
    if (spot) {
      const a = spawnNpc(w, 'cop', spot.x, spot.y, wrng)
      const b = spawnNpc(w, 'cop', spot.x + 0.8, spot.y, wrng)
      // The pair walks a shared street beat instead of loitering at one corner.
      // Waypoints respect the spawn-safe radius too, so a beat never marches
      // the pair straight through the player's landing zone.
      const beat = [{ x: spot.x, y: spot.y }]
      for (let j = 0; j < 2; j++) {
        const p = randomStreetSpot(w, rng, Tile.Street)
        if (p) beat.push(p)
      }
      assignPatrol(a, beat)
      assignPatrol(b, beat)
    }
  }
}

const sprinkleLoot = (w: World, rng: Rng): void => {
  const table = lootTable(w.floor)
  const n = rng.int(6, 10)
  for (let i = 0; i < n; i++) {
    const building = rng.pick(w.level.buildings)
    const spot = building ? randomFloorInBuilding(w, rng, building) : null
    if (!spot) continue
    const itemId = rng.pick(table)
    dropPickup(w, itemId, spot.x, spot.y, itemId === 'cash' ? rng.int(10, 40) : 1)
  }
}

/** A world weapon-mod pickup: a `pickup` entity whose `itemId` is a mod id (not
 * an item id). Auto-pickup applies it to the grabber's gun (interaction.ts); the
 * `mod.<id>` archetype gives it a distinct rarity-coloured gem sprite + inspect
 * card. The specific mod is fixed at populate time so a seed is reproducible and
 * the pickup is inspectable before you touch it. */
const dropModPickup = (w: World, modId: string, x: number, y: number): void => {
  const e = makeEntity('pickup', `mod.${modId}`, x, y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  addEntity(w, e)
}

/** Deterministically sprinkle weapon-mod pickups: ~`MOD_PICKUP_ROOM_CHANCE` of
 * interior rooms get exactly one, the specific mod chosen weighted by rarity. Uses
 * a DEDICATED `mod-pickups` fork so it neither perturbs the loot/AI stream nor is
 * perturbed by it — same seed → same rooms get the same mods, on every peer. */
const scatterModPickups = (w: World): void => {
  const rng = w.rng.fork('mod-pickups')
  const spawnTx = Math.floor(w.level.spawn.x)
  const spawnTy = Math.floor(w.level.spawn.y)
  for (const building of w.level.buildings) {
    for (const room of building.rooms) {
      // Skip the spawn room so a fresh run doesn't hand you a mod for free.
      if (rectContains(room, spawnTx, spawnTy)) continue
      if (!rng.chance(MOD_PICKUP_ROOM_CHANCE)) continue
      const spot = randomFloorInRoom(w, rng, room, spawnTx, spawnTy)
      if (!spot) continue
      dropModPickup(w, weightedModId(rng), spot.x, spot.y)
    }
  }
}

const rectContains = (r: Rect, tx: number, ty: number): boolean =>
  tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h

/** A random floor tile strictly inside a room — never a wall, the exit, or the
 * spawn tile — as a tile-centre world coord, or null if none found. */
const randomFloorInRoom = (
  w: World,
  rng: Rng,
  room: Rect,
  spawnTx: number,
  spawnTy: number,
): { x: number; y: number } | null => {
  const exitTx = Math.floor(w.level.exit.x)
  const exitTy = Math.floor(w.level.exit.y)
  for (let attempt = 0; attempt < 16; attempt++) {
    const tx = rng.int(room.x, room.x + room.w - 1)
    const ty = rng.int(room.y, room.y + room.h - 1)
    if (w.level.tiles[ty * w.level.w + tx] !== Tile.Floor) continue
    if (tx === spawnTx && ty === spawnTy) continue
    if (tx === exitTx && ty === exitTy) continue
    return { x: tx + 0.5, y: ty + 0.5 }
  }
  return null
}

/** Build an NPC's slotted loadout so its carried weapon is modelled EXACTLY like
 * a player's — a real `ItemStack` in a real slot, able to hold weapon-mods whose
 * effects fold into its shots at the shared fire site. A ranged weapon carries no
 * ammo so it slots at a flat 1, a melee weapon at its durability; innate fists (no
 * durability) get NO loadout — undefined, resolving vanilla exactly as a
 * weaponless NPC did before this component existed, so DEFAULT behavior is
 * unchanged. `mods` (optional) seeds a MODDED enemy — a pierce/explosive/frost gun
 * a tactically distinct threat. */
export const npcLoadout = (weaponId: string, mods?: readonly WeaponMod[]): Loadout | undefined => {
  const def = WEAPONS[weaponId]
  if (!def) return undefined
  const qty = def.kind === 'ranged' ? 1 : def.durability
  if (qty === undefined) return undefined // fists / no-durability melee: innate, unslotted
  const stack: ItemStack = { itemId: weaponId, qty }
  if (mods && mods.length) stack.mods = mods.map((m) => ({ id: m.id, stacks: m.stacks }))
  return { inventory: [stack], activeSlot: 0 }
}

export const spawnNpc = (w: World, archetype: string, x: number, y: number, wrng?: Rng): Entity => {
  const def = NPCS[archetype]
  const e = makeEntity('npc', archetype, x, y)
  e.speed = def.speed
  // Difficulty ramp: +15% hp per floor past the first
  const hp = Math.round(def.hp * (1 + 0.15 * (w.floor - 1)))
  e.health = { hp, max: hp, iframes: 0 }
  // Varied loadout when populated with a weapon stream; direct callers (tests,
  // scenarios) with no `wrng` keep the archetype's signature weapon for stability.
  const weapon = wrng ? rollWeapon(wrng) : def.weapon
  e.combat = { weapon, cooldown: 0 }
  // Slot that weapon into the SHARED loadout component so the NPC carries it just
  // like a player would — moddable, resolved through the one fire site. Innate
  // fists stay unslotted (loadout absent → vanilla), so default behavior holds.
  const ld = npcLoadout(weapon)
  if (ld) e.loadout = ld
  // #78 — carry the archetype's damage-affinity table onto the entity so the
  // shared damage path can read it (absent for neutral townsfolk).
  if (def.resist) e.resist = { ...def.resist }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.ai = {
    mode: 'idle',
    faction: def.faction,
    home: { x, y },
    thinkAt: 0,
    sightRange: def.sightRange,
    // Behavior is a component: the archetype only supplies the DEFAULT brain
    // (populate/scenarios/debug verbs override per-entity). Absent → 'basic'.
    ...(def.behavior ? { behavior: def.behavior } : {}),
    // #68 dormancy: spawn inert with its wake triggers (a sleeping pod / the
    // Derelict Unit's power-cut rouse).
    ...(def.dormant ? { dormant: true } : {}),
    ...(def.wakeOn ? { wakeOn: [...def.wakeOn] } : {}),
  }
  return addEntity(w, e)
}

/** Turn an NPC into a patroller walking `waypoints` (copied, so callers can
 * reuse their arrays). No-op when fewer than 2 points — a beat needs legs. */
export const assignPatrol = (e: Entity, waypoints: { x: number; y: number }[]): void => {
  if (!e.ai || waypoints.length < 2) return
  e.ai.behavior = 'patrol'
  e.ai.params = { ...e.ai.params, waypoints: waypoints.map((p) => ({ x: p.x, y: p.y })) }
  e.ai.patrolIndex = 0
}

const randomFloorInBuilding = (
  w: World,
  rng: Rng,
  building: Building,
): { x: number; y: number } | null => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const tx = rng.int(building.rect.x + 1, building.rect.x + building.rect.w - 2)
    const ty = rng.int(building.rect.y + 1, building.rect.y + building.rect.h - 2)
    if (w.level.tiles[ty * w.level.w + tx] === Tile.Floor) return { x: tx + 0.5, y: ty + 0.5 }
  }
  return null
}

/** A random tile of `tile` type outside the spawn-safe radius, as a tile-centre
 * world coord, or null. Every attempt draws the same two ints whether or not it
 * is rejected — determinism is per-seed, not per-layout. */
const randomStreetSpot = (w: World, rng: Rng, tile: number): { x: number; y: number } | null => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tx = rng.int(1, w.level.w - 2)
    const ty = rng.int(1, w.level.h - 2)
    if (w.level.tiles[ty * w.level.w + tx] !== tile) continue
    const x = tx + 0.5
    const y = ty + 0.5
    if (Math.hypot(x - w.level.spawn.x, y - w.level.spawn.y) < SPAWN_SAFE_RADIUS) continue
    return { x, y }
  }
  return null
}
