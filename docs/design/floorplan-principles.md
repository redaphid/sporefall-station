# Floorplan principles for the station complex generator

Status: **built on `feat/mansion-floorplans`** (`complexLayout.ts`, `complex.ts`,
`complexGraph.ts`; tests in `complexPrinciples.test.ts`). Archetypes 1, 2, 4 and 5
are built; 3 (concentric keep) and 6 (radial hub) are not. Originally checked
against the `complex-floorplans` worktree at `0746082`.

What it is for: complex floors (3, 5, 7...) should read like a big building
someone *planned*: a mansion, castle, monastery, hospital or ship turned into a
space station. They should not read like boxes packed round a corridor. Each rule
below comes from a real building, and each one is stated as a generator rule
that can be tested.

Fixed constraints any change must keep:

- The map is 64 x 64 with a 1-tile hull ring (`LEVEL_W/H`, `layoutSkeleton(n)`).
- Walls are 1 tile. The spine is 3 wide and secondary corridors are 2 wide.
- The output is a pure function of the rng. **Each new stage gets its own
  `rng.fork('<label>')`**, so it cannot reshuffle the stages that already exist.
- `WING_REACH = 4`. Every `Tile.Hall` tile must lie within 4 tiles of a wing.
  This means new service passages must be `Tile.Floor` inside a wing, or stay
  short.
- The objective is the module farthest from the spawn, and it must stay in step
  with `missions.farthestBuilding`. If you change that metric (P2), change both.
- The BFS repair pass still guarantees that every room can be reached.

Vocabulary used below:

- **front**: the wall of a room that faces its corridor.
- **back**: the wall of a room that faces the hull.
- **depth(room)**: the smallest number of doors crossed to reach the room from
  the spawn. This is the "justified access graph" depth from space syntax.
- **band / zone / tier**: these keep the meanings they have in `complexLayout.ts`.

---

## 1. Layout principles

Each principle is laid out the same way. **Source** is the real building.
**Rule** is what the generator does. **Test** is the assertion to add to
`complex.test.ts`.

### P1. A hierarchy of circulation: four widths, never mixed up

**Source.** Hospitals and Kahn's Richards Labs keep public corridors, service
routes and room-to-room doors as separate systems. Country houses run a grand
stair, back stairs and servants' passages side by side.

**Rule.** Use four classes, and never let a lower class feed a higher one
directly. Only the spine may touch the airlock.

| class | width | tile | connects |
|---|---|---|---|
| spine (primary) | 3 | Hall | airlock, gatehouse, halls, secondaries |
| secondary / rung | 2 | Hall | spine to zone fronts, spine to spine |
| service (servant) | 1-2 | Floor, in a wing | back doors of galley, stores, wash, reactor |
| door / arch | 1-3 | Floor | room to room |

**Test.** Every corridor tile belongs to exactly one class. No 1-wide `Hall`
run is longer than 2 tiles, which would be a gap left by a mistake.

### P2. A depth gradient: public, then semi-private, then private

**Source.** Christopher Alexander's Pattern 127, *Intimacy Gradient*. The
Versailles state apartments run guard room, antechamber, second antechamber,
bedchamber, cabinet. Hitman's social-space ladder runs from *public* to *private
personal*.

**Rule.**

1. After the doors are placed, compute depth(room) with a BFS over rooms. The
   corridor counts as depth 0.
2. Hand out roles by depth band instead of by distance from the spawn:
   - depth 1 on the spine: security, mess, depot (public);
   - depth 1 on a secondary: lab, medbay, galley (semi-private);
   - depth 2 or more, or at the end of an enfilade: quarters, the lab
     objective, vault stores (private).
3. The objective is the room with the **maximum depth**. Break ties by Euclidean
   distance, so it keeps its current flavour.
4. Guarantee that at least one room reaches depth 3.

**Test.** `depth(objective) >= 3`. The mean depth of `quarters` is greater
than the mean depth of `mess`.

### P3. Entrance sequence: airlock, gatehouse, bend, then the spine

**Sources.**

- Beaux-Arts *marche*: a planned procession from vestibule to the noble rooms.
- Beaumaris: twin-towered gatehouses and a barbican, the only way in.
- Krak des Chevaliers: a vaulted ramp that changes direction several times.

**Rule.** Replace the bare airlock stub with a **gatehouse** at the spine's
entrance end:

```
   hull  #########                   A  = airlock 3x3 (spawn)
         #A A A#GG#                  G  = guard booths 3x3 each side,
    -->  #A A A+==== spine ....         slit windows (1-tile gaps) onto the passage
         #A A A#GG#                  +  = inner door (the choke point)
         #########
```

- The airlock is a 3x3 room with `Tile.Hall` deck.
- The passage out of it is 3 wide and at least 4 long. A 3x3 security booth
  flanks it on one or both sides. Each booth has a door onto the passage, plus
  one or two single-tile window gaps. Window gaps count as wall for movement and
  let light through.
- 40% of the time, add a **bent entry**: the passage turns 90 degrees once
  before it meets the spine (Krak). The entrance then stops giving the player a
  view straight down the whole spine.
- The security role is always assigned to a gatehouse booth. It no longer means
  "the nearest small room".

**Test.** The first two rooms reached from the spawn include `security`. For bent
entries, there is no straight line of sight from the spawn to the exit tile.

### P4. A grand axis with symmetric wings

**Sources.**

- Villa Rotonda: four-fold symmetry round a domed central hall.
- Kedleston: a central block with two mirrored pavilions.
- Beaux-Arts planning: plans balanced about an axis.
- Stiny and Mitchell's Palladian grammar: 3x3 and 5x3 grids.

**Rule.** Add an `axial` mode that any template may take, at a 35% chance:

- The gatehouse, a vestibule, and the floor's **landmark room** (the great hall,
  or the atrium) sit on one straight line, called the axis.
- The spawn sits on the axis. Today the spawn sits on the spine's end, off the
  core's axis.
- Wings either side of the axis are mirror images. The band `label` sharing
  already does this; it now has to hold for bands *across* the axis as well as
  bands across the spine.
- Symmetry covers **shape and zone kind only**. Roles still roll independently,
  so the mirrored plan does not read as a copy-paste.

**Test.** For axial floors, flipping the wall mask across the axis matches at
least 85% of it. The spawn's column (or row) passes through the landmark room.

### P5. Enfilade suites: a row of rooms with lined-up doors

**Sources.** Versailles's *grand appartement du roi* and the queen's parallel
enfilade. The door of each room lines up with the doors of its neighbours, so you
can see through the whole run.

**Rule.** In a tier cut as `rooms`, 30% of rows with 3-5 rooms become a
**suite**:

- Only room 0 gets a corridor door. It is the antechamber.
- Every internal door sits at the same `u` offset (along the row) or `v` offset
  (across the row), so all the doors fall on one line. Put that line 1-2 tiles in
  from the back wall. This is the "window wall" line at Versailles, and it leaves
  the front walls blank.
- The last room is the *cabinet*. It is the best candidate for the objective or
  a loot room.
- A suite room must be at least 4 x 4, so that the view-line reads as a line.

**Test.** For every suite, all internal door tiles are collinear. The suite's
rooms form a path in the room graph, and each room has depth one greater than the
room before it.

### P6. Served and servant spaces: a back-of-house route

**Sources.**

- Louis Kahn's served and servant spaces: service towers set outside the
  laboratories they serve.
- The country house's green baize door: servants' corridors and back stairs
  hidden behind the state rooms.
- Dishonored 2's Clockwork Mansion: the grey machinery behind the walls, as a
  second route.

**Rule.** In each band deeper than 14 tiles, 50% of the time, run a
**service passage** along the back of the front tier:

- It is 1 wide, or 2 wide for bands 18 or more deep. The deck is
  `Tile.Plating`, and it is not a `Hall` tile.
- It runs parallel to the spine and connects the *back* walls of the rooms it
  passes. Priority order: galley, stores, wash, reactor.
- Its two ends open onto a secondary corridor or the spine through a
  **service door**. That door is rendered like wall-panel plating: the green
  baize door.
- The galley must reach the mess by **two** routes: the serving arch and the
  service passage.
- Enemies may path through it. Lights-out treats it as part of its wing.

**Test.** When a service passage exists, cutting it does not strand any room,
because it is a loop and not a lifeline. It never touches `quarters` except at a
wash closet.

### P7. Poche: thick walls with space carved out of them

**Sources.** Beaux-Arts *poché*: the solid part of a plan, where walls grow thick
and hold stairs, closets and shafts. Baroque palaces and castle walls carry
stairs, garderobes and chambers inside the wall.

**Rule.** Choose some walls to be **2-3 tiles thick** and carve niches into
them:

- A wall between a great hall and its neighbour becomes 3 thick 50% of the time.
  Carve 1x2 niches into it that open to one side only: lockers, suit racks, a
  shrine. Use at most one niche per 4 tiles of wall.
- The hull wall behind a deep zone becomes 2 thick 30% of the time. Each 3x3
  corner of it holds a **duct shaft**: a `Tile.Grate` in a closet reached from a
  1-tile door. This moves vents out of the corridors and into the walls.
- The wall between the ends of two parallel halls holds a **ladder well** 2x2:
  decor now, a floor link later.

This also fixes the "graph paper" feel. Wall thickness *varies*, so the plan
reads as built rather than drawn.

**Test.** At least 8% of wall tiles that are not on the hull have wall on both
sides across their thickness, meaning the wall is 2 or more thick. Every niche
opens to exactly one room.

### P8. A courtyard with a cloister walk, one purpose per side

**Source.** The Plan of St Gall:

- church on the north side of the cloister;
- dormitory and chapter house on the east;
- refectory and kitchen on the south;
- guests and stores on the west, by the gate.

The cloister is the hub that every range opens onto.

**Rule.** Upgrade the ring template's atrium when `iw, id >= 12`:

- The 2-wide `Hall` edge ring already exists. It becomes the **cloister walk**.
  The court inside it keeps the pillar rhythm of one pillar every 3 tiles.
- The four bands round the core each take **one zone kind**. The zone kind
  follows the St Gall ranges:
  - side nearest the airlock: `entry` + `stores` (the gate range);
  - opposite side: `science` (the church, and the landmark);
  - one flank: `habitation` (the dormitory), with wash closets on the side next
    to the science range;
  - the other flank: `commons` (the refectory, mess + galley).
- Rooms in the ranges get their **main door onto the cloister walk**, not onto
  the outer spine. The outer spine becomes the service ring (P6).

**Test.** In cloister floors, 60% or more of the ring's room doors open onto the
atrium walk.

### P9. Towers and bastions at the hull corners

**Sources.** Beaumaris has a round tower at every corner of both wards. Krak des
Chevaliers has towers on its outer curtain wall. The pavilions at the corners of
Kedleston and Hardwick are the tame, domestic version of the same thing.

**Rule.** At 2-4 corners of the occupied hull bounding box, stamp a **tower**:

- A 5x5 to 7x7 block. It is chamfered 1-2 on its outer corners with the existing
  `chamfer()`. It **projects** 2-3 tiles past the hull line of both neighbouring
  bands. Today the outline only steps *in*; towers make it step *out*.
- It is entered from the end of the nearest corridor or band through a 1-wide
  door. That makes it a dead end, which is a defensible pocket.
- Contents are drawn from `security`, `reactor` (engineering floors) or `depot`
  (a vault).
- Towers mark corners on axial floors in pairs: mirror them.
- The projection reuses the band `voidEnds` mechanism in reverse. It needs the
  end zone to exist and to be full depth (`keepStart` / `keepEnd`).

**Test.** The hull outline has convex corners, not just concave notches. Every
tower is a single room of depth 2 or more.

### P10. Loops for gameplay flow: no long dead ends

**Sources.**

- Brogue adds up to 30 loops by punching doorways between rooms that are close
  on the map but far apart in the room graph.
- Unexplored's cyclic generation uses two routes to a goal, and a lock on the
  short one.
- Hitman's target loops and Deus Ex's multiple routes.

**Rule.**

1. After the doors are placed, for each pair of rooms that share a wall and
   whose room-graph distance is 4 or more, punch a door with probability 0.5.
   Stop at `loops = 2 + zones/2`.
2. A dead-end secondary corridor longer than 10 tiles gets a door at its tip
   into the room beyond it, 60% of the time.
3. **Lock-and-key cycle:** in a zone that has a loop through the objective, put
   the locked door on the *short* arc. Put a keycard or console on the *long*
   arc, just before it rejoins (Dormans).

**Test.** The room-plus-corridor graph has cyclomatic number at least 3. No
corridor dead end is longer than 10 tiles. The objective lies on a cycle.

### P11. Wet cores and service clustering

**Source.** Real plans stack plumbing on shared "wet walls". The Lariboisiere
wards had the nurse's room at the head of each ward and toilets at its end.
RimWorld's kitchen, freezer and dining triangle does the same thing.

**Rule.** The mirrored bunk closets already share a wet wall. Extend this:

- In each wing, put `washroom`, `galley` and `medbay` on shared walls where
  possible. When rolling roles, choose a neighbour of an existing wet room with
  weight x3.
- Each `quarters` suite row ends in a shared wash block of 3x5 or more on the
  service-passage side.

**Test.** Across seeds, at least 70% of washrooms share a wall with another wet
room or with `quarters`.

### P12. Nuisance separation: engines away from beds

**Sources.**

- Kahn: "the air to breathe should be away from the air to throw away".
- Hospital pavilions, spaced apart to stop contagion.
- Submarine engine rooms, isolated behind watertight bulkheads from berthing.

**Rule.**

- `reactor` and engineering halls must never share a wall with `quarters`,
  `medbay` or `mess`. Between them there must be a corridor or a buffer room
  (`depot`).
- Engineering zones prefer band ends and hull corners.
- The lab objective is buffered by an antechamber: a depth +1 room, as in P5.

**Test.** There are 0 reactor/quarters wall contacts in 500 seeds.

### P13. A small set of room proportions, plus one gallery per floor

**Sources.**

- Palladio's *Quattro Libri*: rooms drawn from the square and the ratios 3:4,
  2:3 and 1:2.
- Hardwick Hall's 50 m Long Gallery, which runs along a whole side of the house.

**Rule.**

- For ordinary rooms, **clamp aspect ratios** to [1:1, 1:2]. Re-cut any strip
  that would produce a 4x11 sliver.
- Once per floor (60%), make a **gallery**: a long room 4-5 wide and 14-24 long.
  It lines the hull face of a band, and it replaces a `rooms` tier. There are
  pillars or planters every 4 tiles along its inner wall. Door it at both ends so
  it forms a loop (P10).
- The gallery is the lab or observation deck, and a strong ranged-combat lane.

**Test.** 95% of `room`-style rooms have an aspect ratio of 2 or less. Floors
with a gallery contain exactly one room of aspect ratio 3 or more.

### P14. One band per institution: a grid of courts at large scale

**Source.** The Escorial's gridiron: cross walls divide it into about 16 courts.
Each institution has its own band: college to the north, monastery to the south,
church on the central axis.

**Rule.** On the `ladder` template, give each of the three bands **one dominant
zone kind** (`north`, `mid`, `south`) instead of rolling per zone:

- Habitation band, science band, and commons/stores band.
- When the mid band is 12 or more deep, it may hold a 6x6 to 8x8 **light well**:
  a small atrium opening onto both rungs. This gives each institution its own
  court.

**Test.** On ladder floors, at least 70% of zones in a band share one kind.

---

## 2. Whole-floor archetypes

`template` becomes an archetype. Each archetype is a skeleton, a zoning rule and
a set of principles that are switched on. Sketches are schematic, at about 2
tiles per character.

Legend for all sketches:

| symbol | meaning |
|---|---|
| `#` | hull / wall |
| `=` | 3-wide spine |
| `-` `|` | 2-wide secondary |
| `:` | 1-wide service passage |
| `A` | airlock (spawn) |
| `G` | gatehouse booth |
| `H` | great hall |
| `C` | court / atrium |
| `T` | tower |
| `O` | objective |
| `'` | enfilade door |
| `+` | door |

### Archetype 1: Palladian station (Kedleston, Villa Rotonda). Weight 20.

A central block, the *corps de logis*, holds the hall and the saloon on the axis.
Two pavilions sit on either side of it: family (habitation) and service (galley,
stores, engineering). Bent quadrant links join each pavilion to the centre.

```
  T#########                              #########T
  #  family  #                            # service  #
  # quarters #::::::::::    ::::::::::::::# galley   #
  # wash  med#   link   |    |    link    # stores   #
  ####+#######------+   |    |   +--------#######+####
                    |#########|
                    |#  SALOON #   <- landmark, O suite behind
                    |#  (lab)  #'room'room'O
                    |####+######
                    |#   H    #    great hall (mess), pillared
                    |#  hall  #
                    |####+#####
                    |#vestibule#
                    ##GG=+=GG##
                         A
```

- **Skeleton:** the axis spine runs from A to the saloon. Two L-shaped secondary
  links (the quadrants) lead to pavilion zones of 12-16 square at the two far
  corners.
- **Principles on:** P3, P4 (always), P5 (a saloon suite ending in O), P6 (a
  service passage from the service pavilion into the hall), P9 (towers on the
  pavilion corners), P13.

### Archetype 2: Cloister ring (the Plan of St Gall). Weight 20.

```
  ################################
  #  science range (church) H  O #
  #######+#####+######+######+####
  #d #|  :  cloister walk  :  |#r#
  #o #|  : C C C C C C C C :  |#e#
  #r +|  : C   court     C :  |+f#   refectory = mess
  #m #|  : C C C C C C C C :  |#e#   + galley arch
  #  #|  :      walk       :  |#c#
  #######+#####+######+######+####
  # stores   GG  gate range      #
  ##############A#################
```

- **Skeleton:** the existing `ring` with `atrium: true`, forced, plus P8 range
  zoning. The outer corridors become service rings (P6).
- **Landmark:** the court. The objective lies in the science range, as far as
  possible from the gate.
- **Principles on:** P3, P8, P10 (the court is a guaranteed loop), P11 (the
  dormitory's wash sits against the refectory's galley wall).

### Archetype 3: Concentric keep (Beaumaris, Krak des Chevaliers). Weight 15.

```
  T##############################T
  #  outer ward: rooms on hull    #
  #  ============================ #  <- outer ring spine (the lists)
  #  =#########-######-#######= #
  #  =#  inner ward   |  rooms #= #
  #  =#   #####+#####         #= #
  #  -+   #  KEEP O  #        +- #   keep = objective behind
  #  =#   #  (bent)  #        #= #     a bent 2-door entry
  #  =#   ###########         #= #
  #  =###########-###########== #
  #  ============ | ============= #
  T######GG=======+=======GG#####T
                  A
```

- **Skeleton:** a new `concentric` template:
  - an outer 3-wide ring spine, 5-8 tiles in from the hull;
  - an inner 2-wide ring;
  - a central keep zone of 10x10 to 14x14.

  The entrances into the rings are **offset**: the outer gate and the inner gate
  are never on one line. That forces the player to walk part of the way round
  the ring (P3's bent entry at building scale).
- **Principles on:** P3, P9 (all four corners), P10 (both rings are loops), P2
  (the keep is always the deepest).

### Archetype 4: Pavilion hospital (Lariboisiere; Halley VI's module caravan). Weight 15.

```
  #####   #####   #####   #####
  # w #   # w #   # w #   # w #   w = long ward (bunks / medbay)
  # a # C # a # C # a # C # a #   C = open light court between
  # r #   # r #   # r #   # r #       pavilions (void, or bog/moss)
  # d #   # d #   # d #   # d #
  #n+s#   #n+s#   #n+s#   #n+s#   n = nurse/security room at ward head,
  ###+#####+#######+#######+###   s = wash at ward foot (next to it)
 A=GG==========================H  <- one straight spine, hall at end
  ###+#######+#######+#######+#
  # stores / engineering (single-sided) #
  ###############################
```

- **Skeleton:** a `spine` with a **comb band**: 3-5 perpendicular pavilion
  zones, each 7-9 wide and 14-22 deep. They are separated by 5-7 wide **void
  courts** (a voided zone, drawn as atrium deck). The other side of the spine is
  a flat service band.
- **Each ward** is one long hall with pillars (the Nightingale ward). It has a
  3x3 station room at the ward head beside the spine door, and a wash closet at
  the far end.
- **Principles on:** P1, P11, P12 (engineering on the other side of the spine),
  P13 (each ward is effectively a gallery).

### Archetype 5: Ship deck (fleet-type submarine; Halley VI). Weight 20.

```
  #########################################
  #FWD  # sonar' ctrl  'nav # berth'berth #   '  = hatches in one line
  #ctrl +'     'O      '    +'     '      #       (enfilade down the keel)
  #####+#####+#######+######+######+#######
  A==GG=================================H=#  <- side passage (spine)
  #####+######+######+######+######+#######
  # galley| mess  H   # stores# reactor  AFT#
  #   'wash'          #       #  ENGINE    #
  #########################################
```

- **Skeleton:** a `spine` pushed hard toward one side (`sy` at 30-40% of the
  height), with a **transverse bulkhead rhythm**:
  - zones are cut at regular 8-10 tile intervals, so the ship reads as
    compartments;
  - the wall between compartments is a bulkhead, and its hatch lies on one line
    through every compartment (P5 at deck scale);
  - there are no secondary corridors: the hatch line *is* the second route.
- **Zoning:** control forward (the far end from A), berthing and galley
  amidships, reactor aft next to A. It is aft because the airlock sits at the
  engine end, which puts the objective at the bow.
- **Principles on:** P5, P10 (the spine plus the hatch line form a
  ladder-shaped loop), P12.

### Archetype 6: Radial hub (Eastern State Penitentiary, the Panopticon). Weight 10.

```
              #  cells  #
              # ' ' ' ' #
              ###|=|#####
     cells ####  | |   ####  cells
     ' ' '|====  HUB  ====|' ' '
     ####### #  (sec) # #######
              ###|=|###
              #  cells  #
              ###|=|###
                 GG
                 A
```

- **Skeleton:** a central hub of 9x9 to 11x11. It is a `security` hall with a
  chamfered octagon made by `chamfer size 2-3` and a central pillar cluster.
  Four 3-wide spokes run from its midpoints to the hull. The hub is the
  landmark, and it has a line of sight down every spoke.
- **Fill:** each spoke is lined both sides with **cell rows**, rooms 4-5 wide and
  5-7 deep: quarters, labs, depots. Diagonal quadrants between spokes are
  zoned like normal bands, facing the spokes.
- **Loop:** spoke tips join a 2-wide outer ring, 50% of the time.
- **Objective:** at the end of the spoke opposite the entrance, behind a suite
  (P5).
- **Principles on:** P2 (the hub is depth 0, and cells run deeper outward), P3,
  P7 (thick hub walls with niches), P10.

The existing `spine`, `tee` and `ladder` templates stay as the generic fallback,
at a combined weight of about 20%. `ladder` gains P14.

---

## 3. Room adjacency rules

"Touch" means the rooms share a wall line, whether or not there is a door in it.
Apply these when rolling roles: prefer, penalise, or swap roles between rooms of
the same size. The generator does not need to fail when a rule is broken, but
the tests should measure how often each rule holds.

### Must touch (a door or an arch is required)

| room | must touch | why (source) |
|---|---|---|
| galley | mess (serving arch, 2-3 wide) | already built; Prison Architect's kitchen next to the canteen; St Gall's kitchen next to the refectory |
| wash closet | its bunk room | already built; the bunk suite |
| security (gate booth) | the gatehouse passage | P3; Beaumaris gatehouse |
| objective | an antechamber (depth -1), or the end of an enfilade | P2, P5; Versailles cabinet |
| great hall | the spine or the axis (the double door) | P4 landmark; Beaux-Arts |
| reactor | an engineering corridor or a depot | P12; submarine machinery spaces |

### Should touch (weight x3)

| room | should touch |
|---|---|
| galley | depot (the cold store: RimWorld's kitchen, freezer and dining triangle) |
| medbay | quarters wing, or the gatehouse (triage near the entry) |
| washroom | another wet room (galley, medbay, wash) or quarters |
| lab | lab or medbay (a science cluster), and a depot |
| quarters | quarters (dorm rows), with a wash block at the row end |
| depot | the service passage, when one exists |

### May touch (neutral)

- lab with mess;
- depot with anything other than quarters;
- security with anything;
- medbay with mess.

### Must never touch

| pair | why |
|---|---|
| reactor with quarters, medbay or mess | P12: noise, radiation, "air to throw away" (Kahn) |
| washroom with galley via a *door* | hygiene. A shared wall is fine; a door is not. |
| quarters with the spine at the airlock end (depth 1 within 10 tiles of the spawn) | P2: private rooms are never the first rooms you meet |
| two great halls | the existing "never a second mess" rule, extended to shape |
| objective with the spine, directly | P2: it must be reached through at least one room |

---

## 4. Gap list: what the current generator lacks

The list is ranked by payoff, meaning how much it changes how the floor reads
and plays, weighed against cost.

1. **No depth gradient.** Roles are rolled per zone palette. The objective is
   simply the room farthest from the spawn in Euclidean distance, so it often
   sits one door off the spine. Adding the room-graph depth BFS (P2) is cheap. It
   reuses the existing `bfs`, `roomAt` and `doorOwners`, and it is what makes
   the floor feel *planned*. Cost: small, but `missions.farthestBuilding` must
   change in step. **Highest payoff.**
2. **Too few loops.** `spine` and `tee` are trees. Secondary corridors are dead
   ends by design ("a dead-end service hall"), and room-to-room doors appear only
   as a repair fallback. The Brogue-style loop pass plus a lock on the short arc
   (P10) fixes chase flow and gives the objective a real approach. Cost: small,
   as a post-pass after section 5 of `complex.ts`.
3. **The entrance is a corridor end.** The spawn is dropped at the spine's tip,
   and "security" is just the nearest small room. A gatehouse with an optional
   bent entry (P3) gives every floor a legible start and a first fight. Cost:
   medium. It needs a stamped entry module ahead of the bands in
   `layoutSkeleton`.
4. **No enfilades and no interior circulation.** Every room is doored to a
   corridor independently (`doorRuns` picks runs at random). Aligned suites (P5)
   are the single most "palace-like" move, and they create the depth P2 needs.
   Cost: medium. It is a new tier style in `layoutZone`, with links emitted like
   the closet links.
5. **No servant layer.** There is no back-of-house route. The galley reaches the
   mess only through the arch. Adding service passages (P6) gives flanking
   routes, a stealth/lights-out gameplay layer, and the "machinery behind the
   walls" fiction. Cost: medium. It must satisfy `WING_REACH`, so it uses
   Floor/Plating inside wings, not Hall.
6. **The outline only notches inward.** Ragged depths and voided end zones step
   the hull *in*. Nothing projects *out*, so floors still read as squares with
   bites taken out. Corner towers (P9) fix the silhouette. Cost: small to medium.
7. **All walls are 1 tile.** There is no poche, so plans look drawn, not built.
   Vents sit on corridor floors instead of in walls. Thick walls with niches,
   duct shafts and ladder wells (P7) add texture and hiding spots. Cost: medium,
   because the door-candidate logic assumes 1-thick walls. Restrict niches to
   walls with no doors in them.
8. **Only four skeletons, and all are orthogonal slabs.** There is no pavilion
   comb, no concentric rings, no radial hub and no ship compartments (section 2,
   archetypes 3-6). Cost: large per archetype. Do them one at a time, starting
   with the pavilion comb, which reuses bands most directly.
9. **Symmetry is only across the spine.** `symmetric` mirrors the north band
   into the south. There is no axis *through* the entrance to a landmark, so
   plans never read as Palladian (P4). Cost: medium. It needs the spawn on the
   axis, plus a mirrored band pair across that axis.
10. **The atrium is a void, not a cloister.** The ring's atrium is circulation
    that no room opens onto. The ranges round it are not given one purpose per
    side (P8). Cost: small, because the zoning and door preferences already exist.
11. **Adjacency is only enforced for galley to mess and closet to bunk.** Nothing
    stops a reactor sharing a wall with quarters, or scatters wet rooms apart
    (section 3, P11, P12). Cost: small, as a scoring pass when rolling roles.
12. **Room proportions are unconstrained.** `cutStrip` bounds each dimension
    separately, so slivers still appear. There is no signature long gallery
    (P13). Cost: small.
13. **Zones are not grouped into institutions.** On `ladder`, each zone rolls
    its kind independently (P14). Cost: trivial.

Suggested order of implementation: 1, 2, 3, 11, 10, 4, 6, 5, 9, 12, 7, then the
archetypes (gap 8), which build on everything above them.

---

## 5. Sources

Architecture and planning:
- Enfilade https://en.wikipedia.org/wiki/Enfilade_(architecture) · Parti https://en.wikipedia.org/wiki/Parti_(architecture) · Beaux-Arts https://en.wikipedia.org/wiki/Beaux-Arts_architecture
- Poche https://www.designingbuildings.co.uk/wiki/Poche · https://www.researchgate.net/publication/340165964_Plan_Poche · https://link.springer.com/article/10.1007/s11709-010-0098-y
- Alexander, Intimacy Gradient https://christopher-alexander-ces-archive.org/record/intimacy-gradient-pattern-original/
- Space syntax https://www.researchgate.net/publication/350176023_Bill_Hillier's_Legacy_Space_Syntax-A_Synopsis_of_Basic_Concepts_Measures_and_Empirical_Application
- Kahn, served and servant https://en.wikipedia.org/wiki/Richards_Medical_Research_Laboratories · https://misfitsarchitecture.com/2022/11/20/architecture-myths-33-served-and-servant-spaces/

Houses and palaces:
- Hardwick Hall https://en.wikipedia.org/wiki/Hardwick_Hall · Long gallery https://en.wikipedia.org/wiki/Long_gallery
- Kedleston https://en.wikipedia.org/wiki/Kedleston_Hall · https://www.nationaltrust.org.uk/visit/peak-district-derbyshire/kedleston-hall/the-history-of-kedleston-hall
- Villa Rotonda https://en.wikipedia.org/wiki/Villa_La_Rotonda · https://archeyes.com/villa-capra-la-rotonda-andrea-palladio/
- Stiny and Mitchell, The Palladian Grammar http://www.contrib.andrew.cmu.edu/~ramesh/teaching/course/48-747/subFrames/readings/Stiny&MItchell-1978-EPB5_5-18.ThePalladianGrammar.pdf
- Versailles https://en.wikipedia.org/wiki/Appartement_du_roi · https://en.wikipedia.org/wiki/Grand_appartement_de_la_reine · https://en.chateauversailles.fr/discover/estate/palace/king-state-apartment
- El Escorial https://en.wikipedia.org/wiki/El_Escorial · https://www.studiomatrx.org/architecture-canon/el-escorial
- Servants' quarters and the green baize door https://en.wikipedia.org/wiki/Servants'_quarters · https://britishheritage.com/history/butlering-green-baize-door

Castles, monasteries and institutions:
- Beaumaris https://en.wikipedia.org/wiki/Beaumaris_Castle · https://www.worldhistory.org/Beaumaris_Castle/ · Concentric castle https://en.wikipedia.org/wiki/Concentric_castle
- Krak des Chevaliers https://en.wikipedia.org/wiki/Krak_des_Chevaliers · Bent entrance https://en.wikipedia.org/wiki/Bent_entrance · https://archeologie.culture.gouv.fr/crac-chevaliers/en/redesign-entrance-system
- Plan of St Gall https://en.wikipedia.org/wiki/Plan_of_Saint_Gall · https://www.medievalists.net/2022/01/st-gall-plan-medieval-monasteries/
- Pavilion hospitals https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5174455/ · https://healthcaredesignmagazine.com/trends/history-hospitals-and-wards/903/
- Panopticon https://en.wikipedia.org/wiki/Panopticon · Eastern State https://en.wikipedia.org/wiki/Eastern_State_Penitentiary
- Fleet-type submarine https://maritime.org/doc/fleetsub/chap3.php · Ship compartments https://en.wikipedia.org/wiki/Compartment_(ship)
- Halley VI https://www.bas.ac.uk/polar-operations/sites-and-facilities/facility/halley/halley-research-station-module-layout/ · https://www.architecturalrecord.com/articles/2789-halley-vi-antarctic-research-station-by-hugh-broughton-architects

Games and procedural generation:
- Lopes et al., A Constrained Growth Method for Procedural Floor Plan Generation (GAME-ON 2010) https://publications.tno.nl/publication/104066/Yar9HQ/lopes-2010-constrained.pdf
- Brogue level generation https://brogue.fandom.com/wiki/Level_Generation · http://anderoonies.github.io/2020/03/17/brogue-generation.html
- Cyclic dungeon generation (Unexplored) https://www.boristhebrave.com/2021/04/10/dungeon-generation-in-unexplored/ · https://www.gamedeveloper.com/design/unexplored-s-secret-cyclic-dungeon-generation-
- Hitman (GDC) https://gdcvault.com/play/1026531/Level-Design-Workshop-Hitman-Levels · https://gdcvault.com/play/1023849/Level-Design-in-HITMAN-Guiding · https://www.gamedeveloper.com/design/mapping-out-the-subtle-social-cues-throughout-i-hitman-i-s-level-design
- Dishonored 2, the Clockwork Mansion https://joncheetham.medium.com/the-lore-and-design-of-dishonored-2s-famous-clockwork-mansion-6e275be95012 · https://kotaku.com/a-closer-look-at-dishonored-2-s-clockwork-mansion-1789429571
- Deus Ex https://www.gamedeveloper.com/business/warren-spector-explains-the-player-first-design-choices-behind-i-deus-ex-i-
- RimWorld https://rimworldwiki.com/wiki/Colony_Building_Guide · Prison Architect https://prison-architect.fandom.com/wiki/Deployment · https://prison-architect.fandom.com/wiki/Canteen
- Townscaper and WFC https://en.wikipedia.org/wiki/Townscaper · https://github.com/mxgmn/WaveFunctionCollapse · Dwarf Fortress talks https://dwarffortresswiki.org/index.php/List_of_Dwarf_Fortress_developer_interviews
