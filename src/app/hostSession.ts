import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { setupFloor } from '../game/systems/missions'
import { createWorld, tickWorld, type World } from '../game/world'
import type { InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import type { CoopSample } from '../input/gamepadCoop'
import type { RenderView, Session } from './session'

/** Local co-op provider: one sample() of every joined pad's player input. */
export interface CoopSource {
  sample(): CoopSample
}

// Slot 0 (the first pad) shares player 0 with the keyboard so the camera target
// stays under the primary human; extra pads become players 1, 2, 3.
const spawnOffset = (slot: number): number => slot * 1.5

const mergeCmd = (a: InputCmd, b: InputCmd): InputCmd => {
  const useB = Math.hypot(b.moveX, b.moveY) > Math.hypot(a.moveX, a.moveY)
  return {
    seq: a.seq,
    moveX: useB ? b.moveX : a.moveX,
    moveY: useB ? b.moveY : a.moveY,
    aimX: useB ? b.aimX : a.aimX,
    aimY: useB ? b.aimY : a.aimY,
    attack: a.attack || b.attack,
    interact: a.interact || b.interact,
    special: a.special || b.special,
  }
}

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

  private joined = new Set<number>()
  isPaused = false

  constructor(
    seed: number,
    private classId: string,
    private localInput: InputSource,
    private coop?: CoopSource,
  ) {
    this.world = createWorld(seed, 1)
    populateWorld(this.world)
    setupFloor(this.world)
    this.self = spawnPlayer(this.world, 0, classId, this.world.level.spawn.x, this.world.level.spawn.y)
  }

  private spawnJoined(slot: number): void {
    if (slot === 0) return // player 0 already exists (self)
    if (this.joined.has(slot)) return
    this.joined.add(slot)
    const spawn = this.world.level.spawn
    spawnPlayer(this.world, slot, this.classId, spawn.x + spawnOffset(slot), spawn.y)
  }

  tick(): void {
    this.inputs.clear()
    this.inputs.set(0, this.localInput.sample())
    if (this.coop) {
      const sample = this.coop.sample()
      if (sample.pauses.length > 0) this.isPaused = !this.isPaused
      for (const slot of sample.joins) this.spawnJoined(slot)
      for (const [slot, cmd] of sample.inputs) {
        const existing = this.inputs.get(slot)
        this.inputs.set(slot, existing ? mergeCmd(existing, cmd) : cmd)
      }
    }
    if (this.isPaused) return
    for (const [playerId, cmd] of this.remoteInputs) this.inputs.set(playerId, cmd)
    tickWorld(this.world, this.inputs)
  }

  renderView(): RenderView {
    return {
      entities: this.world.entities,
      events: this.world.events,
      tick: this.world.tick,
      level: this.world.level,
      floor: this.world.floor,
      missionText: this.world.mission.description,
      missionComplete: this.world.mission.complete,
      gameOver: this.world.gameOver,
      self: this.self,
    }
  }
}
