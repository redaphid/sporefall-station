import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { setupFloor } from '../game/systems/missions'
import { createWorld, tickWorld, type RunMode, type World } from '../game/world'
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

/** Clamp an aim vector to unit magnitude, preserving its angle. Out-of-spec pads
 * (Stadia reads up to ~1.11 on diagonals) would otherwise over-scale the reticle
 * and any magnitude-driven consumer; the sim's facing is angle-only so this is a
 * no-op there. A zero/near-zero vector passes through untouched. */
const clampAim = (x: number, y: number): { x: number; y: number } => {
  const mag = Math.hypot(x, y)
  return mag > 1 ? { x: x / mag, y: y / mag } : { x, y }
}

/**
 * Merge two commands that drive the SAME player entity (the primary human). The
 * ONLY call site folds a pad's command (`b`) onto the local keyboard/touch
 * command (`a`) for slot 0 — so `a` is always the keyboard/touch source and `b`
 * is always the pad, and this runs ONLY when a pad IS present/joined on slot 0.
 *
 * Move: by move magnitude (the larger wins), so WASD and the stick both drive.
 *
 * Aim: once a PAD is on slot 0, the PAD OWNS AIM OUTRIGHT — the desktop mouse
 * never moves the gun. `b` already carries a deadzoned aim (gamepadCoop.toCmd →
 * selectAim): a deflected stick is its aim; a CENTRED stick is (0,0), which the
 * sim reads as "hold the last facing" (movement.ts gates on |aim| > 0.01). So
 * releasing the stick HOLDS the last aim instead of snapping to the stale cursor.
 * The keyboard/mouse aim (`a`) is dropped entirely here.
 *
 * Why: the desktop mouse-aim provider (keyboard.ts + main.ts) emits a CONSTANT
 * unit vector toward wherever the cursor last sat — magnitude ~1 forever, even
 * when the player is on the pad and never touching the mouse. Letting it into the
 * merge at all made the gun track BOTH the mouse and the stick — "it should only
 * track the gamepad if one is detected". A pad on slot 0 means one is detected.
 *
 * The no-pad desktop mouse+keyboard path and the phone/touch path never reach
 * here (no pad on slot 0 → `mergeCmd` is not called), so both are unchanged.
 * Different players occupy different slots and never merge here, so this cannot
 * cross-contaminate one player's aim with another's.
 */
const mergeCmd = (a: InputCmd, b: InputCmd): InputCmd => {
  const useBMove = Math.hypot(b.moveX, b.moveY) > Math.hypot(a.moveX, a.moveY)
  const aim = clampAim(b.aimX, b.aimY)
  return {
    seq: a.seq,
    moveX: useBMove ? b.moveX : a.moveX,
    moveY: useBMove ? b.moveY : a.moveY,
    aimX: aim.x,
    aimY: aim.y,
    attack: a.attack || b.attack,
    interact: a.interact || b.interact,
    special: a.special || b.special,
    hotbar: b.hotbar >= 0 ? b.hotbar : a.hotbar,
    throwItem: a.throwItem || b.throwItem,
    roll: a.roll || b.roll,
  }
}

/**
 * Authoritative sim driver. Solo play is a HostSession with no remote peers;
 * M5 plugs remote InputCmds into `remoteInputs` and broadcasts snapshots.
 */
export class HostSession implements Session {
  world!: World
  self!: Entity
  private inputs = new Map<number, InputCmd>()
  /** M5: net layer deposits latest per-player commands here. */
  readonly remoteInputs = new Map<number, InputCmd>()

  private joined = new Set<number>()
  isPaused = false
  /** Debug harness hook: sees the composed slot→command map right before it is
   * fed to `tickWorld` — the ground-truth input for record/replay. */
  onTickInputs?: (inputs: Map<number, InputCmd>) => void

  constructor(
    private seed: number,
    private localInput: InputSource,
    private coop?: CoopSource,
    /** Difficulty rules for the run — `casual` keeps death forgiving (kid mode). */
    private mode: RunMode = 'normal',
  ) {
    this.buildRun()
  }

  /** Generate floor 1 from the seed and spawn the local player. Used at start
   * and by restart() — a fresh run from default state. */
  private buildRun(): void {
    this.world = createWorld(this.seed, 1, this.mode)
    populateWorld(this.world)
    setupFloor(this.world)
    this.self = spawnPlayer(this.world, 0, this.world.level.spawn.x, this.world.level.spawn.y)
  }

  /** Play again from a game-over: rebuild the run in place. (Solo has no
   * transport; joined co-op pads re-press to rejoin.) A `seed` argument starts a
   * FRESH run from a new seed ("New Seed"); omitted replays the current seed. */
  restart(seed?: number): void {
    if (seed !== undefined) this.seed = seed >>> 0
    this.joined.clear()
    this.buildRun()
    this.isPaused = false
  }

  /** The current run's seed — the app layer reads it to choose a DIFFERENT one
   * for "New Seed". */
  get currentSeed(): number {
    return this.seed
  }

  private spawnJoined(slot: number): void {
    if (slot === 0) return // player 0 already exists (self)
    if (this.joined.has(slot)) return
    this.joined.add(slot)
    const spawn = this.world.level.spawn
    spawnPlayer(this.world, slot, spawn.x + spawnOffset(slot), spawn.y)
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
    this.onTickInputs?.(this.inputs)
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
      missionTargetId: this.world.mission.targetEntityId,
      gameOver: this.world.gameOver,
      mode: this.world.mode,
      revivesLeft: this.world.revivesLeft,
      self: this.self,
      annotations: this.world.annotations,
    }
  }
}
