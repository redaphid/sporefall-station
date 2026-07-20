import { describe, it, expect } from 'vitest'
import { HostSession } from './hostSession'
import { emptyInput, type InputCmd } from '../game/types'
import type { CoopSample } from '../input/gamepadCoop'

// The real primary-human input path: keyboard/touch feeds slot 0 AND the first
// pad feeds slot 0, and HostSession.mergeCmd combines them. A truly idle
// keyboard reports aim (0,0) (createKeyboard → selectAim(0,0,0,0)); emptyInput's
// aimX:1 default is the sim's resting facing, NOT what an idle source emits, so
// these stubs model the real idle keyboard to exercise the merge honestly.
const idleKeyboard = { sample: (): InputCmd => ({ ...emptyInput(), aimX: 0, aimY: 0 }) }

/** A pad command as gamepadCoop.toCmd would produce it: move + resolved aim. */
const padCmd = (moveX: number, moveY: number, aimX: number, aimY: number): InputCmd => ({
  ...emptyInput(),
  moveX,
  moveY,
  aimX,
  aimY,
})

const scripted = (samples: CoopSample[]) => {
  const q = [...samples]
  return { sample: () => q.shift() ?? { inputs: new Map(), joins: [], leaves: [], pauses: [] } }
}

/** Run one tick and return both the merged InputCmd fed to the sim for `slot`
 * (ground truth from onTickInputs) and the session, so tests can read facing. */
const tickCapture = (session: HostSession): Map<number, InputCmd> => {
  let captured = new Map<number, InputCmd>()
  session.onTickInputs = (inputs) => {
    captured = new Map([...inputs].map(([k, v]) => [k, { ...v }]))
  }
  session.tick()
  return captured
}

describe('stationary aim: a deflected aim stick drives facing even with the move stick centred', () => {
  it('move = 0 + aim deflected → merged aim reflects the aim angle (bug: it was dropped)', () => {
    // Aim down-right-ish at a non-axis angle; move stick fully centred.
    const aimX = 0.6
    const aimY = 0.8
    const theta = Math.atan2(aimY, aimX)
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, aimX, aimY)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, idleKeyboard, coop)
    const merged = tickCapture(session)
    const cmd = merged.get(0)!
    // The merged command the sim consumed carries the aim-stick vector...
    expect(Math.atan2(cmd.aimY, cmd.aimX)).toBeCloseTo(theta, 6)
    expect(Math.hypot(cmd.aimX, cmd.aimY)).toBeGreaterThan(0.9)
    // ...so facing (set from atan2(aimY,aimX) in movement.ts) followed it.
    expect(session.self.facing).toBeCloseTo(theta, 6)
  })

  it('moving one way while aiming another → aim follows the aim stick, not the move heading', () => {
    const aimX = -1 // aim left
    const aimY = 0
    const coop = scripted([
      { inputs: new Map([[0, padCmd(1, 0, aimX, aimY)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, idleKeyboard, coop)
    const merged = tickCapture(session)
    const cmd = merged.get(0)!
    // Move heading is +x (right); facing must be −x (left), the aim stick.
    expect(cmd.moveX).toBe(1)
    expect(session.self.facing).toBeCloseTo(Math.PI, 6)
  })

  it('aim centred on every source → facing holds (no snap to a default)', () => {
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 0)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, idleKeyboard, coop)
    session.self.facing = 1.234 // a known prior heading
    tickCapture(session)
    expect(session.self.facing).toBe(1.234)
  })

  it('over-unity aim magnitude (~1.11 on a Stadia diagonal) is clamped to ≤1, angle preserved', () => {
    // 1.11 at 45°: components 0.785,0.785 → mag 1.11.
    const aimX = 0.785
    const aimY = 0.785
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, aimX, aimY)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, idleKeyboard, coop)
    const cmd = tickCapture(session).get(0)!
    expect(Math.hypot(cmd.aimX, cmd.aimY)).toBeLessThanOrEqual(1 + 1e-9)
    expect(Math.atan2(cmd.aimY, cmd.aimX)).toBeCloseTo(Math.atan2(aimY, aimX), 6)
    expect(session.self.facing).toBeCloseTo(Math.PI / 4, 6)
  })

  it('a real mouse-aiming keyboard still wins when the pad aim is centred (mouse path intact)', () => {
    const mouseAim = { sample: (): InputCmd => ({ ...emptyInput(), aimX: 0, aimY: 1 }) } // aim down
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 0)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseAim, coop)
    const cmd = tickCapture(session).get(0)!
    expect(session.self.facing).toBeCloseTo(Math.atan2(1, 0), 6)
    expect(cmd.aimY).toBe(1)
  })
})

describe('co-op: each player keeps its own aim; one player standing still does not lose aim', () => {
  it("two players aim different ways; neither's stationary aim is dropped", () => {
    // Player 0 (keyboard slot 0 + pad slot 0) stands still aiming left; player 1
    // (pad slot 1) stands still aiming down. Each facing must be its own aim.
    const p0aim = padCmd(0, 0, -1, 0) // left
    const p1aim = padCmd(0, 0, 0, 1) // down
    const coop = scripted([
      {
        inputs: new Map([
          [0, p0aim],
          [1, p1aim],
        ]),
        joins: [1],
        leaves: [],
        pauses: [],
      },
      {
        inputs: new Map([
          [0, p0aim],
          [1, p1aim],
        ]),
        joins: [],
        leaves: [],
        pauses: [],
      },
    ])
    const session = new HostSession(1, idleKeyboard, coop)
    session.tick() // spawn player 1
    session.tick()
    const players = session.world.entities.filter((e) => e.playerCtl)
    const p0 = players.find((e) => e.playerCtl!.playerId === 0)!
    const p1 = players.find((e) => e.playerCtl!.playerId === 1)!
    expect(p0.facing).toBeCloseTo(Math.PI, 6) // left
    expect(p1.facing).toBeCloseTo(Math.atan2(1, 0), 6) // down
  })
})

describe('desktop mouse-aim must NOT hijack an actively-aimed gamepad (the re-run bug)', () => {
  // The desktop mouse-aim provider (keyboard.ts + main.ts pointerAim) emits a
  // CONSTANT unit vector toward wherever the cursor last sat — magnitude ~1
  // forever, even when the player is on the pad and never touches the mouse. A
  // pure aim-magnitude race let that stale mag-1 phantom tie/beat a stationary
  // stick reading ≤1.0, snapping facing to the cursor: the gun points where the
  // mouse sits (often ~opposite the real aim → "inverted"). The deflected pad
  // stick must win; only a CENTRED pad yields to the mouse.
  const mouseUp = { sample: (): InputCmd => ({ ...emptyInput(), aimX: 0, aimY: -1 }) } // cursor up, mag 1

  it('cardinal stationary stick (mag exactly 1.0) beats a stale mouse aim (mag 1.0)', () => {
    // Stadia cardinals read ~1.0 (over-unity only on diagonals). Player aims DOWN.
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 1.0)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUp, coop)
    const cmd = tickCapture(session).get(0)!
    expect(session.self.facing).toBeCloseTo(Math.PI / 2, 6) // DOWN (pad), not UP (mouse)
    expect(cmd.aimY).toBeCloseTo(1, 6)
  })

  it('a PARTIALLY-deflected stick (mag 0.6) still beats the mouse — deflection is deliberate', () => {
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 0.6)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUp, coop)
    tickCapture(session)
    expect(session.self.facing).toBeCloseTo(Math.PI / 2, 6) // DOWN (pad)
  })

  it('an over-unity diagonal stick (mag ~1.11) beats the mouse and is clamped', () => {
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0.785, 0.785)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUp, coop)
    const cmd = tickCapture(session).get(0)!
    expect(session.self.facing).toBeCloseTo(Math.PI / 4, 6) // down-right (pad)
    expect(Math.hypot(cmd.aimX, cmd.aimY)).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('a stick BELOW the deadzone (mag 0.1) yields to the mouse — no phantom flicker', () => {
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 0.1)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUp, coop)
    tickCapture(session)
    expect(session.self.facing).toBeCloseTo(-Math.PI / 2, 6) // UP (mouse), pad ignored
  })

  it('a CENTRED stick yields to the mouse — desktop mouse-aim still works with a pad plugged in', () => {
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0, 0)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUp, coop)
    tickCapture(session)
    expect(session.self.facing).toBeCloseTo(-Math.PI / 2, 6) // UP (mouse)
  })

  it('the classic "inverted" case: cursor opposite the aim, stick wins so the gun is NOT flipped', () => {
    // Cursor sits up-left (stale); player pushes the stick down-right. Pre-fix the
    // gun snapped up-left (mag-1 mouse), reading as inverted. Now it points down-right.
    const mouseUpLeft = { sample: (): InputCmd => ({ ...emptyInput(), aimX: -0.707, aimY: -0.707 }) }
    const coop = scripted([
      { inputs: new Map([[0, padCmd(0, 0, 0.707, 0.707)]]), joins: [0], leaves: [], pauses: [] },
    ])
    const session = new HostSession(1, mouseUpLeft, coop)
    tickCapture(session)
    expect(session.self.facing).toBeCloseTo(Math.PI / 4, 6) // down-right (pad), not up-left (mouse)
  })
})
