// Turn a playable's `start` into the world it plays in. Pure: the same start
// gives the same world on every device, so the menu, the capture script and
// the determinism test all play one world.

import { hasFixture, loadFixture } from '../game/fixtures'
import { startRun } from '../game/runStart'
import { applyScenario } from '../game/scenarios'
import { nextFloor } from '../game/systems/missions'
import type { World } from '../game/world'
import type { PlayStart } from './types'

export const buildPlayWorld = (start: PlayStart): World => {
  switch (start.kind) {
    case 'fixture': {
      if (!hasFixture(start.fixture)) throw new Error(`no such fixture: ${start.fixture}`)
      return loadFixture(start.fixture)
    }
    case 'preset': {
      const { world } = startRun(start.seed)
      if (!applyScenario(world, start.preset, { floor: start.floor })) throw new Error(`no such preset: ${start.preset}`)
      return world
    }
    case 'run': {
      const { world, self } = startRun(start.seed)
      // The normal progression down to floor N: the next floor of the run is
      // generated from its seed, exactly as walking through N-1 exits would.
      while (world.floor < start.floor) nextFloor(world)
      if (start.hp !== undefined && self.health) self.health = { ...self.health, hp: start.hp, max: start.hp }
      if (start.loadout && start.loadout.length > 0) {
        self.loadout = { inventory: start.loadout.map((s) => ({ ...s, mods: s.mods?.map((m) => ({ ...m })) })), activeSlot: 0 }
        if (self.combat) self.combat.weapon = start.loadout[0].itemId
      }
      return world
    }
  }
}
