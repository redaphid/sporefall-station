import { emptyInput, type InputCmd } from '../game/types'
import { selectAim } from './aim'
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
  /** Dodge-roll edge: fire once, on the first tick of the segment. */
  roll?: boolean
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
  cmd.roll = !!s.roll && i === 0
  const aim = selectAim(cmd.moveX, cmd.moveY)
  cmd.aimX = aim.x
  cmd.aimY = aim.y
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
  // Pluggable-NPC-AI showcase (scenario `npc-ai`, stage centre 32,32): stand
  // among the cast, sucker-punch the civilian (skittish → alert), then flee
  // west and duck north behind the L-wall so the hunter loses the trail and
  // sweeps. The rest of the clip watches the behaviors play out.
  'npc-ai': [
    { ticks: 40 }, // establish: patrol walks its beat, scavenger heads for loot
    { ticks: 12, attack: true }, // punch the civilian east of us (a crime!)
    { ticks: 60, x: -1 }, // flee west along the lane, hunter in pursuit
    { ticks: 54, y: -1 }, // cut north past the wall's open west end
    { ticks: 12, x: 1 }, // tuck into the pocket behind the L-wall
    { ticks: 330 }, // hide: alert lands, hunter sweeps, scavenger cleans up
  ],
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

  // Open an unlocked door, then pick a locked one (the player channels the lockpick).
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

  // Stand and watch: no input at all. Backs the #50 fire feature video, where the
  // real fire system does all the work — the lit crate row spreads down into a
  // flammable bystander and burns it to death (~tick 100) while the player looks
  // on from the north. 180 ticks (~6s) leaves a clear beat on the aftermath.
  burn: [{ ticks: 180 }],

  // Dodge-roll headline (#54): stand on the lane, then roll INTO an incoming
  // bullet so the i-frame window carries the player through it unharmed. Paired
  // with `dodgeControl` (same world, no roll → the bullet lands) to prove it's
  // the roll, not luck, doing the work.
  dodgeRoll: [
    { ticks: 15 }, // the bullet closes in
    { ticks: 1, roll: true, x: 1 }, // dodge-roll rightward, straight through it
    { ticks: 44 }, // finish the tumble and stand, untouched
  ],

  // Control for the dodge-roll video: never roll — the same bullet connects.
  dodgeControl: [{ ticks: 60 }],

  // Animation-state showcase (feat/sprite-animation): cycle a character through
  // every animation state against the `anim-stage` inline world (player on the
  // lane at x6, one guard thug at x12, a slow bullet inbound from the west that
  // stings the player ~tick 138). idle breathe → walk → attack (pistol shots
  // lunge; the thug flinches HURT then topples DEATH ~tick 104) → the west
  // bullet lands (player HURT flinch) → dodge ROLL east + landing squash →
  // final idle. Every beat is deterministic from this timeline + the world.
  animStates: [
    { ticks: 30 }, // idle: breathe
    { ticks: 20, x: 1 }, // walk east 6 → 9 (lean + bob + stride)
    { ticks: 30 }, // idle again, facing east
    { ticks: 40, attack: true }, // pistol: shots at 80/98/116 — thug hurt, then dies
    { ticks: 100 }, // stand: the west bullet arrives ~138 → player hurt flinch
    { ticks: 1, roll: true, x: 1 }, // dodge-roll east (tumble, tick 220)
    { ticks: 59 }, // landing squash, settle back to idle breathe
  ],

  // Weapon-mod PICKUP headline (feat/mod-pickups): drop onto the lane, then stroll
  // east collecting two scattered mod-gems — the equipped pistol gains a badge per
  // grab (hotbar + inspect update). Paired with the `mod-pickup` inline world whose
  // gems sit on the lane at x≈5.5 and x≈8.5.
  modGrab: [
    { ticks: 40 }, // settle on spawn
    { ticks: 64, y: 1 }, // drop down into the lane (y≈11)
    { ticks: 26 }, // steady on the lane
    { ticks: 30, x: 1 }, // walk right onto the first gem (~x6) → gun gains the mod
    { ticks: 52 }, // pause over it: sparkle + badge appears
    { ticks: 22, x: 1 }, // continue onto the second gem (~x9) → a second badge
    { ticks: 74 }, // final beat on the twice-modded gun
  ],

  // Playtest fix #1 proof: the DEFAULT starter pistol (now a real slotted, 40-round
  // ItemStack) grabs a Cryo Rounds gem off the lane, then fires the frozen rounds
  // into the thug line — freezing then shattering them. Paired with the
  // `starter-mod-fire` inline world (frost gem at x≈5.5, thugs at x=12/15/18).
  modFrostFire: [
    { ticks: 36 }, // settle on spawn
    { ticks: 64, y: 1 }, // drop down onto the lane (y≈11)
    { ticks: 27, x: 1 }, // walk right onto the frost gem (~x5.5) → pistol gains Cryo Rounds
    { ticks: 34 }, // pause: the badge appears on the equipped pistol
    { ticks: 2, x: 1 }, // face east toward the thug line
    { ticks: 150, attack: true }, // stand and empty frozen rounds into them — freeze then shatter
    { ticks: 40 }, // aftermath on the frosted/shattered line
  ],

  // Mission-UI showcase: the player stands STILL for the whole clip so the
  // Playwright driver can expand the mission panel and tap an objective link —
  // any movement would cancel the camera focus (focusModel.ts), which is exactly
  // what we're recording. 660 ticks (~22s) covers chip → panel → link tap →
  // animated pan out/back → edge indicator beats.
  missionui: [{ ticks: 660 }],

  // Mission-marker proof (marker-vs-render parity at the SE map corner): stand
  // still while the e2e teleport-hops the player along the 🎯 marker toward the
  // briefcase, walk the last stretch EAST onto it (real pickup), then hold. The
  // long windows give the wall-clock Playwright acts deterministic sim room.
  missionMarker: [
    { ticks: 300 }, // spawn beat + hops land in here
    { ticks: 25, x: 1 }, // the last metre: walk east onto the briefcase
    { ticks: 275 }, // completion + exit-compass beats
  ],

  // Mission-UI progress states: the `mission` walk to the briefcase, then a LONG
  // stand-still beat (600 ticks) so the e2e can open the panel and tap the exit
  // link with generous wall-clock slack (screenshots are slow under video
  // recording), then finish the floor.
  missionProgress: [
    { ticks: 40 },
    { ticks: 64, y: 1 }, // down onto the lane
    { ticks: 30 },
    { ticks: 57, x: 1 }, // onto the briefcase (~tick 190: objective completes)
    { ticks: 600 }, // hold: panel/link interactions land in this window
    { ticks: 34, x: 1 }, // head for the open exit
    { ticks: 90 }, // floor 2 beat
  ],

  // Sprite-facing showcase: walk a full compass circle — E, SE, S, SW, W, NW,
  // N, NE — with a LONG hold after each leg. Facing persists while idle (aim
  // (0,0) holds the last heading), so each hold is a stable window for the e2e
  // to screenshot that facing even though screenshots under video recording
  // lag the sim by ~60 ticks. Legs cancel pairwise, so the walker ends where
  // it started. Backs the feature-walk8 e2e video (8 facings from 5 drawn
  // directions + 3 mirrors).
  walk8: [
    { ticks: 20 }, // settle (idle, facing s)
    { ticks: 14, x: 1 }, // E
    { ticks: 70 },
    { ticks: 14, x: 1, y: 1 }, // SE
    { ticks: 70 },
    { ticks: 14, y: 1 }, // S
    { ticks: 70 },
    { ticks: 14, x: -1, y: 1 }, // SW (mirrored se art)
    { ticks: 70 },
    { ticks: 14, x: -1 }, // W (mirrored e art)
    { ticks: 70 },
    { ticks: 14, x: -1, y: -1 }, // NW (mirrored ne art)
    { ticks: 70 },
    { ticks: 14, y: -1 }, // N
    { ticks: 70 },
    { ticks: 14, x: 1, y: -1 }, // NE
    { ticks: 70 }, // final beat, resting on the ne facing
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
