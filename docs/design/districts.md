# The sunken city's districts

Floors 1 and 2 are the sunken city. Floor 1 is always the landing (downtown). Floor 2 draws its district from the run seed, picking slums, Still Row or the Culture Beds and never repeating floor 1's district. The table is `OPENING_POOLS` in `src/game/levelgen/floors.ts`. Each district is one entry in `THEMES` in `src/game/levelgen/level.ts`.

The two generic districts, `industrial` and `park`, never appeared in play, and they read as any city's. They are now reworked against the setting. A colony drains essence from swamp water into catchable bubbles; then the trade died and the colony is sinking (`docs/LORE.md`). Its technology is "catching, caging and decanting bubbles": brass, copper coil, glass, wire cages (`setting-fit.md`, G2).

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

These are the props and tiles both districts would use. Today they borrow the props they reuse above.

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

None of these keys is wired into the engine yet. Each new prop needs an archetype in `src/game/data/objects.ts` and an entry in `PROP_NAMES`. A district tile also needs per-district tile selection in the renderer.
