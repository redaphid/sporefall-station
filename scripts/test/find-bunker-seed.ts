// Find seeds whose MISSION building is a bunker (objective behind 3 locked
// doors) — candidates for the progression-fix e2e video.
// Usage: npx tsx scripts/test/find-bunker-seed.ts
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

for (let seed = 1; seed <= 80; seed++) {
  for (let floor = 1; floor <= 3; floor++) {
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    const b = w.mission.targetBuilding !== undefined ? w.level.buildings[w.mission.targetBuilding] : undefined
    if (b?.role !== 'bunker') continue
    const locked = w.entities.filter((e) => e.door?.locked)
    const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
    console.log(
      `seed=${seed} floor=${floor} mission=${w.mission.template} lockedDoors=${locked.length} ` +
        `L=${locked.map((d) => d.door!.lockLevel).join(',')} spawn=(${w.level.spawn.x},${w.level.spawn.y}) ` +
        `target=(${target?.pos.x.toFixed(1)},${target?.pos.y.toFixed(1)}) doors=${locked.map((d) => `(${d.pos.x},${d.pos.y})`).join(' ')}`,
    )
  }
}
