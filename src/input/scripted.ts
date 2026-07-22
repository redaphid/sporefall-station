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
  /** The USE/throw button, held for every tick of the segment (cooldown-gated):
   * uses the held/active item, or dodge-rolls when there's nothing usable. */
  use?: boolean
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
  cmd.throwItem = !!s.use
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
  // Deliberate-AI showcase (scenario `npc-deliberate`, stage centre 32,32):
  // the player only strolls and stands — every beat on stage is the AI's own.
  // Establish the cast, walk south INTO the lurker pocket (the proximity trip
  // springs the ambush), back out to centre stage, then hold while the boxed
  // hunter routes around its U-wall and the squad stacks the door, breaches
  // together, and sweeps in.
  'npc-deliberate': [
    { ticks: 50 }, // establish: lurker dormant, hunter boxed, squad posted
    { ticks: 30, y: 1 }, // stroll south to the pocket mouth (~y 37)
    { ticks: 120 }, // the trip: it bursts out and presses in
    { ticks: 26, y: -1 }, // back up toward centre stage
    { ticks: 474 }, // hunter rounds the U; squad stacks, breaches, sweeps in
  ],

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
    { ticks: 1, interact: true }, // start the lockpick channel (L1 = 60 ticks)
    { ticks: 75 }, // hold still while it picks — deterministic: the lock WILL give
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

  // Melee-swing headline (feat/weapon-sprites): drop onto the lane, march east
  // into the thug line (combat-stage: thugs at x=12/15/18, y=11), then HOLD the
  // attack — the equipped melee weapon swings on its cooldown cadence, arcing
  // through the crowd. Backs the weapon-swing feature video (plain + modded).
  meleeSwing: [
    { ticks: 30 }, // settle on spawn
    { ticks: 64, y: 1 }, // drop down onto the lane (y≈11)
    { ticks: 66, x: 1 }, // march east into melee range of the first thug (~x11.5)
    { ticks: 6, x: 1 }, // face east, planted
    { ticks: 150, x: 1, attack: true }, // press in swinging — arcs land, crowd reels
    { ticks: 40 }, // aftermath beat
  ],

  // Stand and watch, longer: input-free 260 ticks. Backs the shader-FX videos —
  // the showcase scenario's staggered grenades boom at ~70/140/210 (shockwave +
  // kaleidoscopic bloom), and the exit-portal idle clip just breathes.
  fxIdle: [{ ticks: 260 }],

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

  // Fire-uses-active-item headline: a wounded player holds a bandage in the active
  // slot and presses FIRE — instead of a gun shot, the bandage is USED (heals) and
  // spent. No bullet leaves the barrel. Backs feature-fire-item-roll.
  fireUseItem: [
    { ticks: 20 }, // establish: wounded, bandage in hand
    { ticks: 1, attack: true }, // FIRE → uses the bandage, hp jumps
    { ticks: 49 }, // stand healed; nothing was fired
  ],

  // Use→dodge-roll fallback headline: hands hold nothing usable (an out-of-ammo
  // gun), so pressing USE dodge-rolls ("backflip on the use key") — the i-frames
  // carry the player through an inbound bullet. Same duel world as dodgeRoll,
  // triggered off the USE button. Backs feature-fire-item-roll.
  useFallbackRoll: [
    { ticks: 15 }, // the bullet closes in
    { ticks: 1, use: true, x: 1 }, // USE with nothing usable → dodge-roll east through it
    { ticks: 44 }, // finish the tumble, untouched
  ],

  // Stop-drop-and-roll (#roll-douses-fire): the player starts ABLAZE (a fresh
  // 240-tick weapon burn), burns for a beat, then rolls twice — roll 1 at tick
  // 30 smothers 150 ticks, roll 2 at tick 75 kills the remainder. Paired with
  // `stopDropControl` (same world, no rolls → the burn runs its full 240 ticks
  // and costs ~52 hp instead of 16).
  stopDropRoll: [
    { ticks: 30 }, // ablaze: the ember pulse + hp drain establish the stakes
    { ticks: 1, roll: true, x: 1 }, // roll 1 (east): burn cut 240→60 remaining
    { ticks: 44 }, // cooldown; still alight, still ticking
    { ticks: 1, roll: true, x: -1 }, // roll 2 (back west): burn OUT at tick 75
    { ticks: 164 }, // stand clean — no pulse, hp holds
  ],

  // Control for stop-drop-and-roll: never roll — the same burn runs all 240 ticks.
  stopDropControl: [{ ticks: 240 }],

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

  // Mission-marker proof (marker-vs-render parity at the SE map corner): the
  // player stands still for the whole clip; every move is a debug-verb teleport
  // hop sequenced by the e2e itself (never a fixed-tick walk — Playwright's
  // wall-clock cost per still would race it). The pickup still runs the real
  // autoPickup system: the final hop just lands inside pickup range.
  missionMarker: [{ ticks: 400 }],

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

  // The bunker heist (fixture `bunker-heist`: seed 7 floor 3, player staged
  // east of the bunker airlock). The previously-blocked mission path, end to
  // end: PICK the two L2 airlock doors (deterministic 3.5s channels, progress
  // ring on screen), circuit the guard band, BREACH the core door with the
  // grenade special (loud — the boom pulls investigators), grab the briefcase
  // → MISSION COMPLETE. Geometry from levelgen seed 7 floor 3: outer door
  // (40.5,53.5), inner (38.5,53.5), core door (26.5,55.5), briefcase (31.5,53).
  'bunker-heist': [
    { ticks: 30 }, // settle on the approach
    { ticks: 14, x: -1 }, // west up to the OUTER airlock door
    { ticks: 90 }, // stand — the "Lock II · Use to pick (3.5s)" prompt shows
    { ticks: 1, interact: true }, // pick #1 starts (L2 = 105 ticks)
    { ticks: 112 }, // hold still, ring fills, door pops
    { ticks: 15, x: -1 }, // through the vestibule to the INNER door
    { ticks: 15 },
    { ticks: 1, interact: true }, // pick #2
    { ticks: 112 },
    { ticks: 12, x: -1 }, // into the guard band
    { ticks: 27, y: 1 }, // south along the east strip
    { ticks: 84, x: -1 }, // west along the south strip
    { ticks: 14, y: -1 }, // north, up beside the CORE door
    { ticks: 3, x: 1 }, // face the door (sets aim east)
    { ticks: 1, special: true }, // GRENADE — breach the core door
    { ticks: 45 }, // fuse, boom, door blown open (we eat some blast — loud is costly)
    { ticks: 22, x: 1 }, // step through the breach
    { ticks: 26, x: 1, y: -1 }, // angle up toward the briefcase
    { ticks: 10, x: 1 },
    { ticks: 80 }, // briefcase auto-grabs → MISSION COMPLETE banner
  ],

  // Weapon-AIM showcase (fix/weapon-aim-and-pistol-art): the held weapon points
  // at the CONTINUOUS aim (facing = the move heading here), full 360° INCLUDING
  // straight DOWN — decoupled from the body's 8-way sprite quantization. Move into
  // open space, then pulse a facing and HOLD it (aim (0,0) holds the last heading)
  // so the e2e can snap a still per direction: E, SE, S (down!), SW (west mirror),
  // W. Backs the feature-weapon-aim stills.
  aimShowcase: [
    { ticks: 20 }, // settle
    { ticks: 40, x: 1, y: 1 }, // walk into the open (SE), away from the walls
    { ticks: 30 }, // settle, planted
    { ticks: 5, x: 1 }, // face E (0°)
    { ticks: 90 }, // hold E
    { ticks: 5, x: 1, y: 1 }, // face SE (45°)
    { ticks: 90 }, // hold SE
    { ticks: 5, y: 1 }, // face S — straight DOWN (90°): the case the old code never showed
    { ticks: 90 }, // hold DOWN
    { ticks: 5, x: -1, y: 1 }, // face SW (135°, west mirror)
    { ticks: 90 }, // hold SW
    { ticks: 5, x: -1 }, // face W (180°, west mirror)
    { ticks: 90 }, // hold W
  ],

  // Swing-composes-on-aim proof: face straight DOWN, then HOLD the attack — the
  // melee arc sweeps around the downward aim (idle points down; attacking arcs
  // about it), not around a fixed idle. Backs the feature-weapon-aim swing still.
  aimDownSwing: [
    { ticks: 20 }, // settle
    { ticks: 40, y: 1 }, // walk down into the open, facing DOWN
    { ticks: 10 }, // planted, facing down
    { ticks: 120, attack: true }, // swing on cadence around the down aim
    { ticks: 20 }, // aftermath
  ],

  // Hero-art review showcase (art-cn1 in-game): stand idle facing the camera,
  // then walk a full compass circle — E, SE, S, SW, W, NW, N, NE — with a LONG
  // hold after each leg so a screenshot lands cleanly on that facing (captures
  // lag the sim ~60 ticks under video recording; 90-tick holds absorb it). The
  // eight legs cancel pairwise so the walker returns to centre, then it marches
  // east into the thug pair and swings the bat — the combat beat. Pairs with the
  // `artcompare` scenario (player on the lane at x8, thugs at x18/19). Backs the
  // 48px-downscale-vs-hi-res A/B hero-art comparison videos.
  artcompare: [
    { ticks: 90 }, // idle, facing south (toward camera)
    { ticks: 14, x: 1 }, // E
    { ticks: 90 },
    { ticks: 14, x: 1, y: 1 }, // SE
    { ticks: 90 },
    { ticks: 14, y: 1 }, // S
    { ticks: 90 },
    { ticks: 14, x: -1, y: 1 }, // SW (mirrored se art)
    { ticks: 90 },
    { ticks: 14, x: -1 }, // W (mirrored e art)
    { ticks: 90 },
    { ticks: 14, x: -1, y: -1 }, // NW (mirrored ne art)
    { ticks: 90 },
    { ticks: 14, y: -1 }, // N
    { ticks: 90 },
    { ticks: 14, x: 1, y: -1 }, // NE
    { ticks: 90 },
    { ticks: 10, x: 1 }, // face east, staying on the lane clear of the thug line
    { ticks: 160, attack: true }, // plant and fire east down the lane into the thug line
    { ticks: 40 }, // aftermath beat
  ],

  // Weapon-combo showcase (demo/weapon-combos): the player is PRE-POSITIONED on
  // the lane just west of the stationary dummy row (thugs at x=12/15/18, y=11),
  // so there is no walk-in preamble — a tight ~6.4s clip that is almost entirely
  // "aim + hold fire + watch the on-hit effect". Face east for a beat (so aim
  // holds the east heading), then plant and empty the weapon down the row; the
  // final beat lingers on the aftermath (frozen/burning/shattered/exploded line).
  // Backs one mp4 per ammo/mod combo — see e2e/weapon-combos.mjs.
  comboFire: [
    { ticks: 10 }, // establish the dummy row
    { ticks: 6, x: 1 }, // turn to face east toward the targets
    { ticks: 150, attack: true }, // plant and fire down the row (aim holds east)
    { ticks: 26 }, // aftermath beat on the on-hit effect
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
