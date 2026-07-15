import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from './input'

/**
 * A fixed per-tick input timeline. Because the sim samples exactly one command
 * per tick, replaying a timeline makes a whole session bit-for-bit deterministic
 * regardless of wall-clock/render jitter — the basis for repeatable demo/e2e
 * recordings that double as regression tests.
 */
export interface ScriptStep {
  /** How many sim ticks this segment lasts (30 ticks = 1s). */
  ticks: number
  /** Move axis, -1..1. */
  x?: number
  y?: number
  /** Held down for every tick of the segment (cooldown-gated by the sim). */
  attack?: boolean
  /** Edge actions: fire once, on the first tick of the segment. */
  interact?: boolean
  special?: boolean
}

export const scriptTicks = (steps: ScriptStep[]): number => steps.reduce((n, s) => n + s.ticks, 0)

const stepCmd = (s: ScriptStep, i: number, seq: number): InputCmd => {
  const cmd = emptyInput()
  cmd.seq = seq
  cmd.moveX = s.x ?? 0
  cmd.moveY = s.y ?? 0
  cmd.attack = !!s.attack
  cmd.interact = !!s.interact && i === 0
  cmd.special = !!s.special && i === 0
  if (cmd.moveX !== 0 || cmd.moveY !== 0) {
    cmd.aimX = cmd.moveX
    cmd.aimY = cmd.moveY
  }
  return cmd
}

export const createScriptedInput = (steps: ScriptStep[]): InputSource => {
  const plan: InputCmd[] = []
  for (const s of steps) for (let i = 0; i < s.ticks; i++) plan.push(stepCmd(s, i, plan.length))
  let idx = 0
  return {
    sample(): InputCmd {
      const cmd = idx < plan.length ? plan[idx] : emptyInput()
      idx++
      return cmd
    },
  }
}

// 30 ticks = 1s. Player moves ~0.15 tiles/tick. Tuned against the `demo`
// scenario (spawn 1.5,1.5; lane y=11; medkit x5.5; civilians x8/9; door x12;
// thugs x19,20 on the lane). Every segment is deterministic.
export const SCRIPTS: Record<string, ScriptStep[]> = {
  demo: [
    { ticks: 50 }, // settle on spawn
    { ticks: 64, y: 1 }, // drop down into the plaza lane
    { ticks: 45 }, // look around
    { ticks: 30, x: 1 }, // walk right, scooping up the medkit at x=5.5
    { ticks: 45 }, // pause over the pickup
    { ticks: 20, x: 1 }, // continue toward the civilians (~x9)
    { ticks: 80 }, // mingle with the civilians
    { ticks: 17, x: 1 }, // step up to the door (stops at x≈11.5, thugs still unaware)
    { ticks: 30 }, // pause at the door
    { ticks: 1, interact: true }, // open the door
    { ticks: 75 }, // watch it swing open
    { ticks: 30, x: 1 }, // advance on the thugs; they spot the player and charge
    { ticks: 1, special: true, x: 1 }, // lob a grenade into them
    { ticks: 26, x: 1, attack: true }, // press in firing the pistol
    { ticks: 24, attack: true }, // hold ground, finish them off
    { ticks: 90 }, // stand over the aftermath
    { ticks: 40, x: 1 }, // stroll over to where they fell
    { ticks: 90 }, // final beat
  ],

  // Open an unlocked door, then pick a locked one (soldier channels the lockpick).
  doors: [
    { ticks: 40 },
    { ticks: 64, y: 1 }, // down onto the lane
    { ticks: 30 },
    { ticks: 28, x: 1 }, // up to the unlocked door at x=6
    { ticks: 24 },
    { ticks: 1, interact: true }, // swing it open
    { ticks: 55 },
    { ticks: 31, x: 1 }, // through it, up to the locked door at x=11
    { ticks: 24 },
    { ticks: 1, interact: true }, // start the lockpick channel
    { ticks: 60 }, // hold still while it picks (moving cancels) — first try botches
    { ticks: 1, interact: true }, // retry — this one pops the lock
    { ticks: 80 }, // watch the lock give and the door swing open
    { ticks: 40, x: 1 }, // step through the opened door
    { ticks: 70 },
  ],

  // Pistol gallery: stand and fire down the lane at three frozen targets.
  shooting: [
    { ticks: 40 },
    { ticks: 64, y: 1 }, // down onto the lane
    { ticks: 40 },
    { ticks: 52, x: 1 }, // advance until all three are inside pistol range
    { ticks: 24 },
    { ticks: 160, attack: true }, // hold the line and empty the pistol into them
    { ticks: 60 },
  ],

  // A full mission: grab the briefcase (objective complete), then reach the exit.
  mission: [
    { ticks: 40 },
    { ticks: 64, y: 1 }, // down onto the lane
    { ticks: 30 },
    { ticks: 57, x: 1 }, // walk to the briefcase at x=10 and pick it up
    { ticks: 70 }, // MISSION COMPLETE — hold on the banner
    { ticks: 34, x: 1 }, // head for the now-open exit at x=15
    { ticks: 60 }, // step onto it → next floor
  ],
}
