// A fresh run: floor 1 of `seed`, populated and set up, with player 0 at its
// spawn point. HostSession starts every solo/host run here, and the playable
// scenarios (src/playable/start.ts) build their run starts and `?scenario=`
// presets on it, so a scenario starts from the same world a run does.

import type { Entity } from './entity'
import { spawnPlayer } from './player'
import { populateWorld } from './populate'
import { playerSpawnPoint } from './spawnPlacement'
import { setupFloor } from './systems/missions'
import { createWorld, type RunMode, type World } from './world'

export const startRun = (seed: number, mode: RunMode = 'normal'): { world: World; self: Entity } => {
  const world = createWorld(seed, 1, mode)
  populateWorld(world)
  setupFloor(world)
  const at = playerSpawnPoint(world.level, 0)
  return { world, self: spawnPlayer(world, 0, at.x, at.y) }
}
