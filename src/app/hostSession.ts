import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { createWorld, tickWorld, type World } from '../game/world'
import type { InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import type { RenderView, Session } from './session'

/**
 * Authoritative sim driver. Solo play is a HostSession with no remote peers;
 * M5 plugs remote InputCmds into `remoteInputs` and broadcasts snapshots.
 */
export class HostSession implements Session {
  readonly world: World
  readonly self: Entity
  private inputs = new Map<number, InputCmd>()
  /** M5: net layer deposits latest per-player commands here. */
  readonly remoteInputs = new Map<number, InputCmd>()

  constructor(
    seed: number,
    private localInput: InputSource,
  ) {
    this.world = createWorld(seed, 1)
    populateWorld(this.world)
    this.self = spawnPlayer(this.world, 0, 'soldier', this.world.level.spawn.x, this.world.level.spawn.y)
  }

  tick(): void {
    this.inputs.clear()
    this.inputs.set(0, this.localInput.sample())
    for (const [playerId, cmd] of this.remoteInputs) this.inputs.set(playerId, cmd)
    tickWorld(this.world, this.inputs)
  }

  renderView(): RenderView {
    return {
      entities: this.world.entities,
      events: this.world.events,
      tick: this.world.tick,
      level: this.world.level,
      self: this.self,
    }
  }
}
