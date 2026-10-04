# The sunken city's districts

Floors 1 and 2 are the sunken city. Each floor draws its district from the run seed, picking from all four districts and never repeating the floor before. The table is `OPENING_POOLS` in `src/game/levelgen/floors.ts`, and each district is one entry in `THEMES` in `src/game/levelgen/level.ts`. All 12 ordered pairs turn up across seeds. A single run sees two districts, because it has two city floors.

The districts are written against the setting. A colony drains essence from swamp water into catchable bubbles; then the trade died, and the colony is sinking (`docs/LORE.md`). Its technology is "catching, caging and decanting bubbles": brass, copper coil, glass and wire cages (`setting-fit.md`, G2). Each district carries:

- a layout (lot density, yard, courtyard and plaza ground, and set-piece odds),
- a role mix,
- the props in its open squares,
- its own encounters from floor 2 (floor 1 stays gentle),
- a floor grade (`DISTRICT_TINT` in `src/render/complexLook.ts`),
- and its own names for its buildings in mission text (`wingNames`).

## The Concourse (`concourse`, was `downtown`)

The colony's company core is where every catch was weighed, tallied and paid out. The corporate signage over its arcades is now striped with the waterline calendar: generations of hand-painted high-water marks (LORE.md). Its forecourt fountains have drowned. The game's money now reads as scrip, the company's pay. That is inferred from the "payday" lines in the flavor-line bank and the payday-token junk core.

- **Layout.** Dense paved blocks (3-4 lots per axis), arcades (corridor spines in 65% of halls) and payroll strongrooms (vaults, 30%). Courtyard pits and plaza hearts are drowned basins (`Tile.Bog`), and yards stay paved.
- **Roles and names.** It has tally halls (`office`), weigh-houses (`shop`), company lodging (`apartment`), the company infirmary (`clinic`) and a bond store (`warehouse`).
- **Squares.** Each square holds 2-4 benches, 1-2 tally tables and sometimes a Nutrient Dispenser.
- **Encounters.** From floor 2, Mireclaw Stalkers scavenge the counters (30% of buildings).
- **Look.** Station white gone yellow, `0xf6eccc`.

## The Moorings (`moorings`, was `slums`)

This is where the generational survivors live. Their shacks are lashed to the old catch-jetties and mooring lines (setting-fit: catch-jetty, mooring cleat), and each generation rebuilds them a stripe higher. Each run is the next diver in the family line (LORE.md, succession). The families' drowned divers still walk the jetties.

- **Layout.** Many small lots (4-5 per axis) with bog water between them (yards and courtyard pits are `Tile.Bog`). Its squares are moss-mat kitchen gardens (`Tile.Grass`).
- **Roles and names.** It has stilt shacks (`apartment`), barter stalls (`shop`, kept by Barter Frogs), net lofts (`warehouse`) and the stripe-painters' hall (`office`).
- **Squares.** Each square holds 2-4 bio-planters, 1-2 cargo crates and sometimes a table.
- **Encounters.** From floor 2, Drowned Divers walk the jetties (35% of buildings host 1-2).
- **Look.** Teal swamp mist, `0xc6e2e2`.

## Still Row (`stillworks`, was `industrial`)

This is where the colony distilled essence for export, and it went cold when the trade stopped. Still houses stand in banks round flooded settling yards, with cage-works and export sheds between them. Cinder Husks, the ash-dwellers, nest in the cold stills. Derelict Units still work their shifts, purpose without a purpose.

- **Layout.** The three-lot grid stays, with dense big halls, high bunker and courtyard odds, and a corridor spine in most halls. Open lots and setback yards are bog shallows. Courtyard pits are settling ponds, and plaza hearts are sumps, all `Tile.Bog`. More low ground also gives the bog-tide modifier more to flood.
- **Roles.** The role mix is still houses (role `reactor`, furnished with barrel banks, lockers and cabinets), cargo holds (`warehouse`) and stores depots (`depot`). A vault's sealed chamber stays a vault.
- **Yards.** Open squares hold 2-4 spore barrels and 1-3 cargo crates, never touching and never on the spawn or exit. Barrels explode, so a yard fight is a hazard.
- **Encounters.** Cinder Husks are thick (50% of buildings host 1-2), and Derelict Units are on shift from floor 2.
- **Look.** A brass and ember grade, `0xf4d8b0` (`DISTRICT_TINT` in `src/render/complexLook.ts`).

## The Culture Beds (`culturebeds`, was `park`)

These are the mycologists' grow terraces. This inference rests on the Mycologist, the bio-planter and hydro-recycler art, and the overgrown biome, "where the sporefall got in". The beds are gone feral. Low labs and infirmaries stand scattered among open beds where planters still stand in rows on the moss. Brood Sacs have taken the furrows, and Spore Mites swarm the moss.

- **Layout.** Lots are open and low (a 55% building chance) with grass yards, wide setbacks and walled garden courts.
- **Roles.** The role mix is essence labs (`lab`, staffed by Mycologists and the odd Derelict Unit), infirmaries (`medbay`), habitation and a commissary.
- **Squares.** Open squares hold 3-6 bio-planters in spaced rows and sometimes a nutrient dispenser.
- **Encounters.** A third of buildings get an extra Brood Sac clutch (2-3), and 40% get extra Spore Mites (1-2).
- **Look.** An olive grow-light grade, `0xcfe8b4`.

## Art the districts would use (not generated yet)

These are the props and tiles the districts would use. Today they borrow the props listed above.

| Key | District | Description for the art pass |
|---|---|---|
| `prop.essence-still` | Still Row | A copper pot still the height of a person, with a brass petcock, a coiled copper condenser and a cracked glass condenser head that glows faint teal. Stands in banks of three. |
| `prop.cage-rack` | Still Row | A wire-cage rack of glass jars, a few with caught bubbles glowing, most empty and fogged. |
| `prop.cargo-sled` | Still Row | A flat export sled stacked with strapped cargo pods, its runners sunk into bog mud. |
| `tile.settling-pond` | Still Row | Bog shallows with a brass-ringed drain grate and an oily teal sheen; it would replace `bog` in yards. |
| `prop.culture-bed` | Culture Beds | A raised wooden bed of black substrate with pale fungal fruiting bodies, some bloated and spore-shedding. |
| `prop.grow-lamp` | Culture Beds | A hanging spore-lamp on a bent pole that casts one olive pool of light (the frame's one hot light). |
| `prop.irrigation-trough` | Culture Beds | A copper trough on trestles, overflowing onto the moss and furred with mycelium. |
| `tile.furrow` | Culture Beds | Tilled moss in parallel furrows with root threads; it would replace `grass` in beds. |
| `prop.weigh-scale` | Concourse | A hanging brass catch-scale with a hook and a jar cage, its needle stuck, the "monger's thumb" counterweight still on it. |
| `tile.waterline-wall` | Concourse | Wall art carrying stacked, hand-painted high-water stripes, each one cruder than the last, over faded corporate lettering. |
| `tile.drowned-basin` | Concourse | A fountain basin's tiled rim around bog water, with a dry spout. It would replace `bog` in its squares and courts. |
| `prop.stilt-shack` | Moorings | A lean-to of airlock fabric and plate on stilts with a ladder, built for the corner of a lot. |
| `prop.mooring-cleat` | Moorings | A big rusted mooring cleat with a frayed line running off into the water. |
| `prop.net-rack` | Moorings | A drying rack of catch-nets and net-poles hung with empty glass jars. |
| `tile.jetty-plank` | Moorings | Lashed plank decking over dark water. It would replace `boardwalk` as the ring round its lots. |

None of these keys is wired into the engine yet. Each new prop needs an archetype in `src/game/data/objects.ts` and an entry in `PROP_NAMES`. A district tile also needs per-district tile selection in the renderer.
