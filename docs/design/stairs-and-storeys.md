# Stairs and storeys

Status: **Phase 1 built** (2026-09-18, `feat/stairs`); Phases 2-4 are still design. Written
against `main` at `f50ab97`.

> **Phase 1 as built: deviations from this spec**
> - **Yield.** A loft is added on *every* complex floor where the rule allows one (the owner's
>   ask), not on about half. The 200-seed x 5-floor sweep yields 997/1000, at about 4 ms per floor.
> - **Stair lock (not in §3.2).** The shaft is the same tile on both storeys, so a player still
>   holding "forward" would bounce between storeys. `Entity.stairLock` is set by a climb. It holds
>   while the body is on the stair or within the landing's 3x3, and clears two tiles out. The
>   client predicts it too: `netClient` replays from the lock as of the last acked input.
> - **Edge test.** The prune's boundary test is 8-neighbour, stricter than §2 step 6's 4. That way
>   every tile that becomes an upper wall, inner corners included, provably bears (D ≤ N).
> - **Ground byte-identity** holds except at the stair shaft: the StairUp tile, plus niche walls
>   when a room corner is used instead of poché. `storeys.test.ts` pins exactly that diff.
> - **Not built yet:** `Tile.Void`, galleries, the `.cap` lintels, basements, z ≥ 2 towers,
>   `usesStairs`, and `findPathAcross`, all of which are Phase 2-4. With no enemies upstairs,
>   groups, the director, NPC pursuit and group spawns all ignore players off the ground storey.
>   The station alert calls an upstairs intruder out at the foot of the stairs (`groundAnchor`).
> - **Art.** `tile.stair_up`, `tile.stair_down` and `tile.landing.overlay` come from
>   `scripts/assets/tiles_stairs.py` for `swampspace-hires` and `swampspace`. `city` uses the
>   procedural fallback in `art.ts`. It also reads the
uncommitted `feat/mansion-floorplans` worktree (the complex rewrite: archetypes, P7 poché thick
walls, P9 corner towers, `ComplexMeta`), because storeys sit on top of whatever that branch
produces.

The ask: *"Support 'stairs': tiles that take you up or down a floor. Floors above must 'make sense'
given the supporting structure below. But towers are fine."*

Vocabulary. In this codebase **floor** already means the run's level number (`World.floor`, floors
1, 2, 4... are city and 3, 5, 7... are complex). This spec uses **storey** for a vertical level
*inside* one floor. "Ground storey" means the map the generators build today.

---

## 0. How it works today (the constraints)

| Area | Today | Why it matters for storeys |
|---|---|---|
| Level | `Level` = one `w*h` grid (`LEVEL_W/H = 64`), `tiles` + `solid`, one `spawn`, one `exit`. Not serialized; it regenerates from `seed+floor` (`levelgen/generate.ts`). | Anything we add must also regenerate bit-exact from `seed+floor`. |
| Tiles | `Tile` ids 0-15 (`levelgen/level.ts`), append-only so that checksums stay stable. There is no stair, void or railing tile. | New ids go on the end: 16+. |
| Descend | `missionSystem`: a live player on the unlocked `Tile.Exit` calls `nextFloor(w)` (`systems/missions.ts:553`). That call **regenerates the world in place**: `floor++`, a new level, all entities dropped, players moved to the spawn, `populateWorld`, then a `floorChange` event. | Floors are thrown away. Nothing persists a floor once you leave it. |
| Net | Snapshots are `u16` x/y at 1/32 tile, so they carry up to 2047 tiles. `flags` is a u8 and **all 8 bits are used** (`game/snapshot.ts`). Snapshots send every player, plus other entities within `INTEREST_RADIUS = 14` of a player (`app/netHost.ts`). `NetClientSession.changeFloor` **ignores any floor that is not deeper** (a replay guard, `netReplayGuard.test`). The client predicts its own movement against `level.solid` (`stepSelf`). A long step is treated as a teleport (`SNAP_DIST`). | There is no spare flag bit for a "storey" field. A monotonic floor is load-bearing. |
| Save | `persistence.ts` stores `serializeWorld` (entities + rng + `levelChecksum`). A checksum drift gets the save **discarded**, not a crash. | Any level change invalidates old saves on those floors. |
| Pathing | `path.ts` runs A* over `level.solid`, 4-connected, with a Manhattan-style heuristic and `PATH_MAX_NODES = 700`. | A stair is a non-local edge, so the heuristic breaks unless we handle it. |
| Floods | These BFS from `level.spawn`: `generate.ts` `bfsReachable`/`repairConnectivity`, `complex.ts` `bfs` repair, `populate.ts commitFurniture` reachability, and the mansion `complexGraph.buildAccessGraph`. | Every reachability guarantee has to traverse stairs. |
| Render | `TilemapView` bakes the whole level into 8x8 chunks and culls them against the camera. `cameraModel.appliedCenter` clamps to `levelW/levelH`. `ZOOM_MIN = 0.5` means a landscape phone can show **over 100 tiles** across. A `dark` layer dims a blacked-out wing. | A single-grid view: whatever is in the grid and on screen gets drawn. |
| Fog / minimap | **Neither exists.** The nearest thing is the lights-out `dark` rect and the DOM locator (`ui/locatorModel.ts`), which gives an off-screen teammate or objective an edge arrow. | Per-storey fog is new work, not a port. No minimap (owner decision). |

---

## 1. Interpretation: recommend (a), stacked storeys inside a floor

| | (a) storeys inside a floor | (b) go back UP to a previous floor | (c) both |
|---|---|---|---|
| Matches "must make sense given the supporting structure below" | **Yes.** This rule only means anything when the upper plan sits over the lower plan. | **No.** Floor N+1 is a *different generator* (city and complex alternate), so it has no structural relation to floor N. | Partly. |
| Netcode | **No wire change** with the atlas layout (§1.1). Storey is derived from position. | Breaks the monotonic-floor replay guard. It needs a floor epoch, and the `u8 floor` rules change. | Both costs. |
| Save / determinism | The level still regenerates from `seed+floor`. Storey state is just entity positions, which are already saved. | Needs a per-floor archive of entity state (dead enemies, looted pickups, doors) in `WorldJson`. Save size grows with depth. The BLE late-join has to ship it. | Both. |
| Gameplay | Verticality, lofts, towers, ambush landings, loot above and below. | Backtracking a roguelite's one-way descent adds little and invites loot farming. | - |

**Recommendation: (a).** It is the only reading the structural clause applies to, and with the
layout below it costs the netcode nothing. The exit tile keeps its one-way "descend" job. It can be
re-skinned later as a stair-down sprite if the human wants a visual match, without adopting (b)'s
semantics. If the human did mean (b), that is a separate feature with its own persistence design.
Ask before building it.

### 1.1 The key decision: the storey atlas

Lay every storey of a floor side by side **in the one `Level` grid**, with a solid gutter between
them:

```
 x:  0 ........ 63 | 64 .. 79 | 80 ....... 143 | 144 .. 159 | 160 ...
     slot 0 (ground) | gutter  | slot 1 (z=+1)  |  gutter    | slot 2 (z=-1) ...
```

- `STOREY_STRIDE = 80`: a 64-tile storey plus a 16-tile gutter of `Tile.Hull`.
  `level.w = 80*n - 16`. `level.h` stays 64.
- **Slot 0 is always the ground storey, at x 0..63.** Its tiles, `spawn`, `exit`, `buildings`
  indices and every rng stream stay **byte-identical** to the no-storey generator.
- A storey is `storeyOf(level, x) = floor(x / STOREY_STRIDE)`. It is a pure function of position, so
  it needs **no entity field, no wire bit and no serialize field**.
- Why it works:
  - Collision, LOS (`los.ts`), projectiles, noise (`HEAR_RANGE = 12`), fear (`FEAR_RADIUS = 5`) and
    netHost interest (`14`) are all shorter than the 16-tile solid gutter. So nothing leaks between
    storeys, and those systems need no changes.
  - Snapshot x fits in 2047 tiles, which is about 25 slots.
  - Save and replay come free: entity positions *are* the storey state.
- The cost: code that assumes a 64x64 level, or that treats straight-line distance as meaningful,
  has to be audited (§6, R2). Examples are `farthestBuilding`, `ALERT_LEASH = 64`, spawn-safety
  radii and the camera clamp.

The alternative is `Level.storeys: Level[]` plus an `Entity.storey` field. That touches combat,
projectiles, AI, LOS, interest, serialize and the wire, where the flags byte is full. It was
rejected for that reason.

### 1.2 New level data (regenerated, never serialized)

```ts
// level.ts: appended ids
Tile.StairUp = 16    // walkable; stepping on it transits to the storey above
Tile.StairDown = 17  // walkable; transits to the storey below
Tile.Void = 18       // solid (railing); open to the storey below; transparent to LOS

interface Storey { slot: number; z: number; kind: 'ground'|'upper'|'tower'|'basement'; ox: number }
interface StairLink { from: Vec2i; to: Vec2i; landing: Vec2i; dir: 'n'|'e'|'s'|'w' } // atlas coords
Level.storeys?: Storey[]      // absent means a single-storey floor (every city floor, for now)
Level.stairs?: StairLink[]    // one per direction; the pair A->B and B->A are two links
```

Stair tiles are **not** `isFloorTile`, so furniture, loot and spawns skip them automatically.
`buildSolid` must treat 16 and 17 as walkable and 18 as solid.

---

## 2. Structural rule: upper storeys must bear on lower walls

All masks are over one storey's local 64x64 tiles. `cheb` is Chebyshev distance. The inputs are
storey `k-1` and its tiles `T`.

1. **Walkable** `F = {t : !isWallTile(T[t]) && T[t] != Void}`.
2. **Footprint** `H = dilate(F, 1)`: the walkable area plus its enclosing walls. This is the
   storey's hull.
3. **Bearing mask** `B = H ∩ wall-family`. It covers outer walls, interior partitions and P7 poché
   (thick `Hull` walls). Tiles in open-sky **courts** (mansion `carveCourt`) are marked `noBear` and
   are excluded both from `B` and from anything above them.
4. **Distance field** `D = cheb distance to B`, computed with the two-pass chamfer at O(64²).
5. **Candidate** `C = erode(H, e)` minus `dilate(courts, 1)`. `e` is the setback, with a default of
   1 and a range of 0-3 per archetype, drawn on `rng.fork('storey:<k>:setback')`.
6. **Bearing prune.** This loop runs to a fixed point:
   - Remove any tile of `C` where `D > SPAN` (`SPAN = 6`, the longest unsupported slab).
   - Remove any **boundary** tile of `C` (one with a 4-neighbour outside `C`) where `D > N`
     (`N = 1`). The outer wall of the storey above must sit on, or within one tile of, a wall below.
   - Repeat until stable.
7. **Clean up.** Drop the components of `C` whose inscribed rectangle is smaller than 5x5 (a 3x3
   room plus its walls). Keep at most `MAX_UPPER_COMPONENTS = 3`, largest first and ties broken by
   the top-left tile, so the result is deterministic.
8. **Carve.**
   - Fill the new slot with `Hull`, then set `C`'s interior to deck.
   - Outer walls go on `∂C`.
   - **Partitions come from the storey below.** Copy `B ∩ interior(C)` up. Delete some segments to
     merge rooms (`rng.fork('storey:<k>:merge')`, p = 0.35 per segment): removing a wall above a
     wall is always sound. Adding a partition is only allowed where `D ≤ N`. The result is that
     every upper wall stands over structure.
   - Punch doors in the kept partitions using the same door-picking code as `splitRooms`.
   - Run a BFS repair **within the storey**, seeded from its stair landings.
9. **Atria become galleries.** Some lower-storey tiles can be open atrium or great-hall space
   (`D > SPAN`), inside `H` and fully enclosed by `C`. Set those upper tiles to `Tile.Void` (a railing)
   instead of removing them. That gives the gallery its view down.
10. **Towers, storey 2 and above.** Apply the same rule to storey `k ≥ 2` only over *tower seeds*:
    - mansion `meta.towers` rooms (P9), or
    - rooms whose wall ring is at least 2 thick on 3 or more sides (P7 poché: thick walls carry
      height).

    For towers, `e = 0`, since a tower rises flush on its thick walls. The rule is **never widen**:
    `H_k ⊆ H_(k-1)` at every level. A tower may stack up to `TOWER_MAX = 3` storeys over ground.
    This is the "towers are fine" clause: a small footprint over a hull corner or a thick-walled
    room climbs, while the broad deck stops at storey 1.
11. **Basements (z = -1).**
    - The footprint must be `⊆ erode(H_0, 1)`: it lies under the ground hull.
    - Unexcavated rock bears everything, so only the **ceiling span** matters: every ground wall
      tile over a basement walkable tile needs `cheb(t, B_basement) ≤ N`, and every basement
      walkable tile needs `D ≤ SPAN`.
    - The basement is generated *after* the ground storey, so this runs as a prune on the basement
      candidate using the ground's `B` as the "must be supported" set.

The stage runs in the new `levelgen/storeys.ts`, called from `generateComplexLevel` **after**
`carveComplex`. It uses its own `rng.fork('storeys')`, so the ground storey and the mission,
director and populate streams do not move. It reads only the tiles and (optionally)
`ComplexInfo`/`ComplexMeta`. It never edits `complex.ts`.

### 2.1 Validation tests (`levelgen/storeys.test.ts`)

Sweep 200 seeds x floors {3, 5, 7, 9, 11}. For every storey `k` with `z ≠ 0`, assert:

1. **Inside the hull.** Every non-Hull tile of storey `k` lies in `H` of the storey it bears on
   (`k-1` going up, `k+1` for the basement).
2. **Walls bear.** Every outer wall tile of an upper storey has `cheb(t, B_below) ≤ N`, and every
   partition has `cheb ≤ N`.
3. **Span.** Every walkable upper tile has `D ≤ SPAN`.
4. **No floating over courts.**
5. **Towers.**
   - Storeys with z ≥ 2 exist only over tower seeds.
   - Footprint area is non-increasing going up.
   - `z ≤ TOWER_MAX`.
6. **Stairs.**
   - Each `StairUp` at local `p` on z has a `StairDown` at local `p` on z+1.
   - `landing` is walkable.
   - The clearance mask (§3.1) holds no door, furniture, spawn, vent or other stair.
7. **Connectivity.** A link-following flood from `spawn` reaches every walkable tile of every
   storey.
8. **Gutter.** Every gutter tile is `Hull` and solid.
9. **Ground byte-identity.** The slot-0 slice equals `generateComplexLevel(seed, floor)` with
   storeys disabled, including `spawn`, `exit` and `buildings`.
10. **Determinism.** Two generations give the same `levelChecksum`.
11. **Yield.** At least 60% of complex floors get at least one upper storey. A rule that prunes
    everything passes silently, so this guards against that.
12. **Adversarial lower storeys, built by hand.** Each of these must produce either no storey or a
    valid one, and must never throw:
    - a single 64x64 hall with no partitions, so `C` is empty (only perimeter galleries or none);
    - one 3x3 room;
    - a checkerboard of pillars;
    - an all-court floor;
    - a lone thick-walled 5x5 (a tower with no deck).

---

## 3. Stairs

### 3.1 Placement and alignment

- A stair is a **vertical shaft**: the same local `(x, y)` on both storeys. The lower storey gets
  `StairUp` there and the upper storey gets `StairDown`.
- Its facing `dir` is the open side. The other three sides are wall-family on **both** storeys, so
  the stair sits in a niche.
- The landing is `p + dir` on each storey. Arrival lands on the landing, **never** on the stair
  tile, so transit cannot ping-pong.
- **Clearance mask.** The 3x3 centred on the landing, minus the wall niche, must be walkable deck on
  both storeys. It may hold no doors, vents, furniture, pickups or spawns, and must be at least 3
  tiles from any other stair, the spawn or the exit. `populate.ts` gets a `reservedKeys(level)` set,
  the same pattern as `bunkerLaneKeys`.
- **Candidates.** A candidate is a local tile `p` whose niche walls lie in `B_below` (a stairwell
  against a bearing wall) and whose landing clears on both storeys.
  - Score by: prefer corridor-adjacent landings (`Hall` deck), then the tower-room interior for
    tower storeys, then the smallest access depth from spawn.
  - Pick one per upper component, plus a second when the component's area is over 400 tiles, so
    there is a loop.
  - Draw from `rng.fork('storey:<k>:stairs')`.
  - Carve the niche in the lower storey only if every tile in it is already wall or a free corner of
    a room of 7x7 or more. Never cut a corridor.

### 3.2 Transit (sim)

- The new `stairSystem(w)` runs right after `movementSystem` in `tickWorld`.
- An entity **transits** when all of these hold:
  - its tile is a stair tile with a link;
  - it is a live player that is not downed, or an NPC with `usesStairs`;
  - it is not a projectile, pickup, door or interactable.
- It then:
  - moves to `landing` + 0.5 (resolved with `spawnPlacement.freeTileCentres` if another body is
    there);
  - sets `prevPos = pos` and zeroes `vel`;
  - pushes `{ type: 'storeyChange', entityId, z }`.

  Knockback that shoves a non-`usesStairs` body onto the tile does nothing.
- The transit logic is a **pure** function, `stairTransit(level, x, y)`, in `src/game/stairs.ts`.
  `NetClientSession.stepSelf` calls the same function, so client prediction teleports on the same
  tick as the host. `reconcile` replays through it, so there is no rubber-banding. Other clients
  already treat the 80-tile jump as a teleport (`SNAP_DIST`).
- `stairs.ts` also exports `linkedNeighbors(level, key)` and `floodLinked(level, start, blocked?)`.
  Every reachability flood listed in §0 switches to these.

### 3.3 AI across storeys

- **Pathing.**
  - If the goal is on the same storey, `findPath` runs unchanged.
  - Otherwise, a new `findPathAcross` BFSes the tiny **storey graph** (nodes are storeys, edges are
    stair links) to choose a chain of stairs. It then runs ordinary A* for each leg (entity to stair
    `from`, landing to the next stair, ..., landing to goal), and each leg keeps the 700-node cap.
  - Because of this, the teleport edge never enters A*'s heuristic.
  - `ai.ts` stores only the current leg, and repath staggering is unchanged.
- **Who follows.** `usesStairs` is an archetype trait:
  - on for crew and humanoid hostiles (thug, cop, scientist, infected);
  - off for bosses (Mireclaw), turrets, spore nodes, vent swarms and Derelict Units.

  A boss that could leave its arena breaks the boss room.
- **Pursuit.**
  - When a target transits out of view, the pursuer's last-seen point becomes the stair tile.
  - When it reaches that tile, it follows if it saw the transit within `FOLLOW_WINDOW = 150` ticks
    (5 s). It then waits `STAIR_FOLLOW_DELAY = 20` ticks on the stair before transiting, which gives
    the player an ambush beat at the landing.
  - A follower chases at most one storey away from its home storey (a leash), and then goes back.
- **Alert.**
  - The station-alert `alertMark` pulls NPCs across storeys via `findPathAcross`. Only `usesStairs`
    NPCs answer.
  - Noise and fear stay single-storey because of the gutter. That is deliberate: you can't hear
    through slabs.

### 3.4 Multiplayer

- Players on different storeys work with no protocol change:
  - Every player is always in every snapshot, and interest is per-avatar.
  - A client derives each teammate's storey from x.
- **Client view.** The client draws only entities on the viewer's storey. The locator's teammate
  arrow becomes a **storey badge** at the screen edge (for example `P2 ▲1`, with red if downed),
  instead of an arrow pointing into the gutter. The objective and exit markers get the same
  treatment.
- **Revive** needs someone on the same storey. That is intended: a downed friend upstairs is a
  reason to climb.
- **Descend** is unchanged. Any live player on the ground-storey exit ends the floor, and
  `nextFloor` moves every player, wherever they are, to the next spawn.
- **Late join** spawns at `level.spawn` (ground), which is unchanged.
- **Divergence.** The `netDesync.test` additions:
  1. The client predicts a transit on the host's tick, with no pull-back after the next snapshot.
  2. A replayed or stale snapshot taken from *before* a transit does not teleport the client back
     down. `reconcile` replays pending inputs through `stairTransit`.
  3. A storey mismatch of any entity shows up as a position divergence.

  Item 3 needs no new `DivergenceKind`. Cover it with a red-proof pair anyway.

### 3.5 Rendering

- **Show only the current storey.**
  - The viewer's storey is `storeyOf(self.pos.x)`. On the host it is the local player.
  - `appliedCenter` takes a bounds rect `{x0, y0, w, h}` instead of `levelW/levelH` and clamps to
    the storey rect. `locatorModel` mirrors it, which `cameraParity.test` pins.
  - `TilemapView` tags each chunk with its slot and sets `visible = false` for other slots. This
    mask is **required**: at `ZOOM_MIN` the screen is wider than 64 + 16 tiles, so culling alone
    would show the next storey.
  - On a `storeyChange` for self, call `camera.snapTo(landing)` and fade in over about 150 ms.
- **The lower storey through voids.** When the tilemap bakes a `Void` tile on slot `s`, it first
  draws the tile at the same local position on the storey below (slot of `z-1`), tinted about 0.35
  and darkened. It then draws the railing overlay. The result is static: entities below are **not**
  shown, because they are outside interest and not on the client. That is honest, and it is a known
  limit.
- **Stairs themselves.**
  - `StairUp` draws steps rising into the niche. `StairDown` draws steps descending into shadow.
  - Both are rotated by `dir`, the way `wallCaps` rotates caps.
  - The landing gets a chevron overlay.
  - The procedural fallback in `art.ts` (`TILE_COLORS` plus a drawn chevron) ships in Phase 1, so no
    theme pack blocks it.
- **Lights-out.** The `dark` layer keys on wings, and wings are per-storey rects, so it works
  unchanged.

### 3.6 Fog, minimap and save

- **Fog.** There is none today. When it is built, it is **client-only**: an `explored`
  `Uint8Array(level.w*level.h)` in the render layer, filled from LOS around the viewer and never
  part of the sim or wire. Because the atlas is one grid, it is per-storey for free. Reset it on
  `floorChange`, which is also the only time the atlas changes.
- **Minimap: NO.** The owner ruled it out on 2026-09-18. Do not build one. Off-storey teammates
  are shown only with the on-screen storey badge / locator arrow ("▲1: P2").
- **Save.** Nothing new. Positions encode storeys, and `levelChecksum` covers the atlas.
  - Bump `SAVE_VERSION` to 3 so pre-storey complex-floor saves are discarded cleanly. They would
    already fail the checksum and be dropped, but the bump makes the intent explicit.
  - Regenerate the `bunker-heist.json` fixture (floor 3).

---

## 4. Sprite needs

The tiles are `TILE_PX = 32` (hires packs double it). Author facing north (open side south) and let
the renderer rotate them. Add keys to `swampspace`, `swampspace-hires` and `city`, and to
`TILE_NAMES` / `TILE_ID_BY_NAME`, which `themeManifestSync`/`themePackParity` enforce.

| Key | What |
|---|---|
| `tile.stair_up` (2-3 variants) | Grated steps rising north into the niche, lit toward the top edge, with handrails on both sides. The lower storey. |
| `tile.stair_down` (2-3 variants) | Steps falling north into dark, with a soft vignette at the far edge. The upper storey. |
| `tile.stair_up.cap` / `tile.stair_down.cap` | A lintel strip for the niche wall, so the wall-cap line runs continuously over the shaft. |
| `tile.void` | A dark drop with a transparent centre (the lower storey shows through) and a railing along all four edges, as an autotiled edge set: `tile.void.edge`, `tile.void.edge.inner`, the same scheme as wall caps. |
| `tile.landing.overlay` | Hazard chevrons or a worn tread decal pointing at the stair. |
| Swamp dressing | Moss and bog-drip overlays for stairs in the `flooded`/`overgrown` biomes (optional). |
| UI glyphs | ▲▼ storey badges for the locator and the storey banner ("DECK 2"). These are DOM or text, not sprites. |

Judge the generated art with the `judge-sprite-mp4` skill only if it is animated. These are static
tiles, so the usual contact sheet is enough.

---

## 5. Phased plan

Every phase follows the repo gate: build, vitest and lint must be green, and every phase gets an e2e
video.

**Timing.** Land **after `feat/mansion-floorplans` merges**. Phase 1 reads that branch's
`ComplexMeta.towers`, and it must not conflict on `level.ts` or `complex.ts`.

### Phase 1: one loft (small, shippable)

On about half of complex floors, add one upper storey over **one** qualifying room: a P9 tower, or
the largest room of 7x7 or more with bearing walls. It is reached by **one** stair pair, holds
**loot only** (a cache crate plus a mod pickup) and has **no enemies**, so there is no AI work. It
uses the whole structural algorithm for that single component, so the rule is enforced from day one.

- `src/game/levelgen/level.ts`: `Tile.StairUp/StairDown`, `Storey`, `StairLink`,
  `Level.storeys/stairs`.
- `src/game/levelgen/storeys.ts` (new) and `storeys.test.ts` (new): masks, prune, carve, stair
  placement.
- `src/game/levelgen/generate.ts`: widen the atlas, call `addStoreys`, `buildSolid`.
- `src/game/stairs.ts` (new) and `stairs.test.ts` (new): `storeyOf`, `stairTransit`, `floodLinked`.
- `src/game/world.ts`: `stairSystem` in the tick order.
- `src/game/types.ts`: the `storeyChange` event.
- `src/game/populate.ts`: reserved clearance keys, `floodLinked` in `commitFurniture`, the loft
  cache, and no NPC spawns off slot 0.
- `src/game/systems/missions.ts`: `farthestBuilding` and `randomFloorTile` consider slot-0 buildings
  only (for now).
- `src/app/netClient.ts`: `stepSelf` and `reconcile` use `stairTransit`.
- `src/app/netDesync.test.ts`: the §3.4 cases.
- `src/render/cameraModel.ts`, `camera.ts`, `renderer.ts`, `tilemap.ts`: the storey clamp, the chunk
  and entity mask, and `snapTo` on a storey change.
- `src/ui/locatorModel.ts`: the storey badge.
- `src/render/art.ts`, `theme.ts`: the procedural stair tiles.
- `src/app/persistence.ts`: `SAVE_VERSION = 3`.
- `src/game/__fixtures__/bunker-heist.json`: regenerate.
- `src/ui/releaseNotes/<date>-stairs.ts`.
- e2e: walk up, grab the cache, walk down. Also a two-client run with one player upstairs.

### Phase 2: full upper deck and galleries

- Run the §2 algorithm over the whole ground hull, with up to 3 components.
- Add `Tile.Void` galleries over atria, drawn with the faded lower storey.
- Populate upper storeys with enemies that stay on their storey.
- Director vents and wings per storey.
- Theme art (§4).

Files: `storeys.ts`, `populate.ts`, `systems/complexDirector.ts`, `tilemap.ts`, `art.ts`, the
`public/themes/*/manifest.json` files and tile PNGs.

### Phase 3: AI and missions across storeys

- `findPathAcross`, the `usesStairs` trait, and pursuit, follow and leash behaviour.
- The alert manhunt crosses storeys.
- The objective may be upstairs. The mansion `buildAccessGraph` counts a stair as a barrier, so
  upper rooms get depth +1.

Files: `path.ts`, `systems/ai.ts`, `systems/behaviors.ts`, `systems/goals.ts`, `data/*` archetypes,
`systems/missions.ts`, `levelgen/complexGraph.ts`, plus adversarial tests (stair camping, a follower
with a blocked landing, a boss never transiting).

### Phase 4: towers, basements and fog

- Storeys with z ≥ 2 over tower seeds, and z = -1 basements under the ground hull.
- A client-side explored mask. **No minimap** (owner decision, 2026-09-18).
- Optionally, city buildings (floor ≥ 2, **never floor 1**, which is frozen) get lofts using the
  same `storeys.ts`.

Files: `storeys.ts`, a new `src/render/fog.ts`, `renderer.ts`, and `generate.ts` (city path).

---

## 6. Risks

- **R1 Branch collision.** The mansion branch rewrites `complex.ts`, `complexLayout.ts` and
  `level.ts`. Mitigation:
  - Storeys live in `storeys.ts` and consume only tiles plus meta.
  - Start after that branch merges.
  - Its P2 depth logic must learn about stairs in Phase 3.
- **R2 Atlas assumptions.**
  - Anything that measures straight-line distance across the whole level silently misbehaves once
    `level.w = 144`. Known cases:
    - `farthestBuilding`, where an upstairs room looks "farthest";
    - `ALERT_LEASH = 64`;
    - `SPAWN_SAFE_RADIUS`;
    - `buildingAt`;
    - the `simMath` bound comment (positions under 64, which is still numerically fine).
  - Audit every `level.w`/`level.h` and `level.spawn` consumer (a grep lists about 20).
  - Add a test that runs a full floor of `tickWorld` on a multi-storey level and asserts that no
    entity ever occupies a gutter tile.
- **R3 Rendering leaks.** Wide screens at `ZOOM_MIN` reach past the gutter. The chunk and entity
  storey mask is mandatory, not polish.
- **R4 Prediction mismatch at the stair.** If the client and host ever disagree about a transit, the
  player rubber-bands 80 tiles. Mitigation: one shared pure `stairTransit`, and `netDesync`
  red/green proofs.
- **R5 Churn.**
  - `levelChecksum` changes for every complex floor that gains a storey. That breaks old saves (a
    clean discard), the `bunker-heist` fixture, and any test that pins complex checksums or populate
    counts.
  - Keep the ground slice byte-identical so that only atlas-aware tests move.
- **R6 Cost on phones.**
  - Levels regenerate at every floor transition, and there are 2-4x more tiles to generate, flood,
    furnish and bake into textures. The Android GPU memory for the baked chunks grows by the same
    factor.
  - Budget: generation under 15 ms per complex floor on the CI box. Hidden chunks stay hidden, and
    none are destroyed or rebuilt.
- **R7 The structural rule over-prunes.** Many archetypes (big halls, courts) may yield no upper
  storey. The yield test (§2.1, item 11) catches it. Tune `N`, `SPAN` and `e` per archetype rather
  than loosening the rule.
- **R8 Gameplay degeneracy.**
  - Stair-dancing to shed aggro: mitigated by the follow window and delay.
  - Split co-op parties: the storey badge and the revive incentive.
  - Loot lofts becoming mandatory detours.
  - The objective sitting over the exit's storey shaft.
  - Playtest each phase and watch the e2e videos.
- **R9 The human meant (b).** The "supporting structure" wording argues for (a), but confirm before
  Phase 1. (b) is a different, persistence-heavy feature.
