import { describe, it, expect, beforeEach } from 'vitest'
import { anyPadActive, createGamepadCoop, cycleHotbar, type CoopDebugPad } from './gamepadCoop'
import { padProfile } from './padProfile'
import type { RenderView } from '../app/session'

const STD = padProfile({ id: 'x', mapping: 'standard', axes: [] })

// A minimal render view carrying just the player entities' inventory/activeSlot,
// which is all the coop hotbar-cycle resolver reads.
const viewWith = (players: { playerId: number; inventory: { itemId: string; qty: number }[]; activeSlot: number }[]) =>
  ({ entities: players.map((p) => ({ playerCtl: p })) } as unknown as RenderView)

const btn = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })

const pad = (
  index: number,
  over: {
    id?: string
    mapping?: string
    buttons?: boolean[]
    axes?: number[]
    axisCount?: number
  } = {},
) =>
  ({
    index,
    id: over.id ?? 'Xbox Wireless Controller',
    mapping: over.mapping ?? 'standard',
    connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => btn(over.buttons?.[i] ?? false)),
    axes: Array.from({ length: over.axisCount ?? 10 }, (_, i) => over.axes?.[i] ?? 0),
  }) as unknown as Gamepad

const press = (i: number) => {
  const b: boolean[] = []
  b[i] = true
  return b
}

describe('createGamepadCoop', () => {
  let pads: (Gamepad | null)[]
  let coop: ReturnType<typeof createGamepadCoop>

  beforeEach(() => {
    pads = []
    coop = createGamepadCoop(() => pads)
  })

  describe('press-to-join', () => {
    it('claims a player slot when an idle pad presses a face button', () => {
      pads = [pad(0, { buttons: press(0) })]
      const r = coop.sample()
      expect(r.joins).toContain(0)
    })
    it('routes that pad input to its player slot', () => {
      pads = [pad(0, { buttons: press(0) })]
      const r = coop.sample()
      expect(r.inputs.has(0)).toBe(true)
    })
    it('does not claim a slot for a pad that never presses anything', () => {
      pads = [pad(0)]
      const r = coop.sample()
      expect(r.joins).toHaveLength(0)
      expect(r.inputs.size).toBe(0)
    })
    it('gives a second pad its own slot', () => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
      pads = [pad(0), pad(1, { buttons: press(0) })]
      const r = coop.sample()
      expect(r.inputs.has(1)).toBe(true)
    })
  })

  describe('per-player input routing', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('feeds stick movement to the joined player', () => {
      pads = [pad(0, { axes: [0.9, 0] })]
      const r = coop.sample()
      expect(r.inputs.get(0)!.moveX).toBeCloseTo(0.9)
    })
    it('holds attack while the button is down', () => {
      pads = [pad(0, { buttons: press(0) })]
      const r = coop.sample()
      expect(r.inputs.get(0)!.attack).toBe(true)
    })
    it('aims from the right stick (axes 2/3) independently of movement', () => {
      pads = [pad(0, { axes: [0, 0, 0, -0.9] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimX).toBeCloseTo(0)
      expect(cmd.aimY).toBeCloseTo(-0.9)
    })
    it('falls back to aim-where-you-move when the right stick is centred', () => {
      pads = [pad(0, { axes: [0.9, 0] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimX).toBeCloseTo(0.9)
      expect(cmd.aimY).toBeCloseTo(0)
    })
  })

  describe('interact is edge-triggered so a held button acts once', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('fires interact on the press', () => {
      pads = [pad(0, { buttons: press(1) })]
      expect(coop.sample().inputs.get(0)!.interact).toBe(true)
    })
    it('stops firing while the button stays held', () => {
      pads = [pad(0, { buttons: press(1) })]
      coop.sample()
      pads = [pad(0, { buttons: press(1) })]
      expect(coop.sample().inputs.get(0)!.interact).toBe(false)
    })
  })

  describe('pause is edge-triggered', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('reports the slot on the Start press', () => {
      pads = [pad(0, { buttons: press(9) })]
      expect(coop.sample().pauses).toContain(0)
    })
    it('does not repeat while Start is held', () => {
      pads = [pad(0, { buttons: press(9) })]
      coop.sample()
      pads = [pad(0, { buttons: press(9) })]
      expect(coop.sample().pauses).not.toContain(0)
    })
  })

  describe('throw is edge-triggered on the pad', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('fires throwItem on the press', () => {
      pads = [pad(0, { buttons: press(STD.throw[0]) })]
      expect(coop.sample().inputs.get(0)!.throwItem).toBe(true)
    })
    it('stops firing while the throw button stays held', () => {
      pads = [pad(0, { buttons: press(STD.throw[0]) })]
      coop.sample()
      pads = [pad(0, { buttons: press(STD.throw[0]) })]
      expect(coop.sample().inputs.get(0)!.throwItem).toBe(false)
    })
  })

  describe('firing is buttons only: L2 shoots, the aim stick never does', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('holds attack while L2 (button 6) is down', () => {
      pads = [pad(0, { buttons: press(6) })]
      expect(coop.sample().inputs.get(0)!.attack).toBe(true)
    })
    it('aims from the right stick without setting attack', () => {
      pads = [pad(0, { axes: [0, 0, 0.9, 0] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimX).toBeCloseTo(0.9)
      expect(cmd.attack).toBe(false)
    })
    it('leaves attack false for a centred right stick and no button', () => {
      pads = [pad(0)]
      expect(coop.sample().inputs.get(0)!.attack).toBe(false)
    })
    it('fires and aims together: L2 held with the stick deflected', () => {
      const b: boolean[] = []
      b[6] = true
      pads = [pad(0, { buttons: b, axes: [0, 0, 0, -0.9] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.attack).toBe(true)
      expect(cmd.aimY).toBeCloseTo(-0.9)
    })
  })

  /**
   * The press that joins a pad is spent on joining. Start doubles as the pause
   * button, so before this rule a player pressing Start to join instantly
   * paused the game; a face-button join fired an attack for the same reason.
   */
  describe('the joining press is inert', () => {
    it('does not pause when Start is the join press', () => {
      pads = [pad(0, { buttons: press(9) })]
      const r = coop.sample()
      expect(r.joins).toContain(0)
      expect(r.pauses).toHaveLength(0)
    })
    it('does not attack when A is the join press', () => {
      pads = [pad(0, { buttons: press(0) })]
      const r = coop.sample()
      expect(r.joins).toContain(0)
      expect(r.inputs.get(0)!.attack).toBe(false)
    })
    it('does not fire a pause edge from Start merely HELD since the join', () => {
      pads = [pad(0, { buttons: press(9) })]
      coop.sample()
      pads = [pad(0, { buttons: press(9) })]
      expect(coop.sample().pauses).toHaveLength(0)
    })
    it('pauses on a fresh Start press after release', () => {
      pads = [pad(0, { buttons: press(9) })] // join
      coop.sample()
      pads = [pad(0)] // release
      coop.sample()
      pads = [pad(0, { buttons: press(9) })] // deliberate pause
      expect(coop.sample().pauses).toContain(0)
    })
    it('attacks normally on the sample after an A-button join while still held', () => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
      pads = [pad(0, { buttons: press(0) })]
      expect(coop.sample().inputs.get(0)!.attack).toBe(true)
    })
  })

  describe('weapon switch: cycle prev/next resolves to an absolute hotbar slot', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
      // Player 0 carries two weapons, slot 0 active.
      coop.update(viewWith([{ playerId: 0, inventory: [{ itemId: 'pistol', qty: 5 }, { itemId: 'bat', qty: 1 }], activeSlot: 0 }]))
    })
    it('cycles to the next slot on the next-button edge', () => {
      pads = [pad(0, { buttons: press(STD.hotbarNext[0]) })]
      expect(coop.sample().inputs.get(0)!.hotbar).toBe(1)
    })
    it('fires the switch once per press (edge), not while held', () => {
      pads = [pad(0, { buttons: press(STD.hotbarNext[0]) })]
      coop.sample()
      pads = [pad(0, { buttons: press(STD.hotbarNext[0]) })]
      expect(coop.sample().inputs.get(0)!.hotbar).toBe(-1)
    })
    it('wraps to the last slot on the prev-button edge from slot 0', () => {
      pads = [pad(0, { buttons: press(STD.hotbarPrev[0]) })]
      expect(coop.sample().inputs.get(0)!.hotbar).toBe(1)
    })
    it('leaves hotbar at -1 when no cycle button is pressed', () => {
      pads = [pad(0, { axes: [0.5, 0] })]
      expect(coop.sample().inputs.get(0)!.hotbar).toBe(-1)
    })
    it('does not switch with no inventory info yet (nothing cached)', () => {
      const fresh = createGamepadCoop(() => pads)
      pads = [pad(0, { buttons: press(0) })]
      fresh.sample()
      pads = [pad(0, { buttons: press(STD.hotbarNext[0]) })]
      expect(fresh.sample().inputs.get(0)!.hotbar).toBe(-1)
    })
  })

  describe('cycleHotbar (pure)', () => {
    const inv = [{ itemId: 'pistol', qty: 1 }, { itemId: 'bat', qty: 1 }, { itemId: 'grenade', qty: 2 }]
    it('advances to the next slot', () => {
      expect(cycleHotbar(inv, 0, 1)).toBe(1)
    })
    it('wraps forward off the end', () => {
      expect(cycleHotbar(inv, 2, 1)).toBe(0)
    })
    it('wraps backward off the start', () => {
      expect(cycleHotbar(inv, 0, -1)).toBe(2)
    })
    it('returns -1 with an empty inventory', () => {
      expect(cycleHotbar([], -1, 1)).toBe(-1)
    })
    it('skips the non-equippable briefcase in display order', () => {
      const withCase = [{ itemId: 'briefcase', qty: 1 }, { itemId: 'pistol', qty: 1 }, { itemId: 'bat', qty: 1 }]
      // display order is [pistol@1, bat@2]; next from pistol(1) -> bat(2)
      expect(cycleHotbar(withCase, 1, 1)).toBe(2)
      // and next from the last wraps back to the first real slot, never the briefcase
      expect(cycleHotbar(withCase, 2, 1)).toBe(1)
    })
    it('starts from the first slot when nothing is active (fists)', () => {
      expect(cycleHotbar(inv, -1, 1)).toBe(0)
      expect(cycleHotbar(inv, -1, -1)).toBe(2)
    })
  })

  describe('hotplug', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('reports the freed slot when the pad disconnects', () => {
      pads = []
      expect(coop.sample().leaves).toContain(0)
    })
    it('stops routing input for a disconnected pad', () => {
      pads = []
      expect(coop.sample().inputs.has(0)).toBe(false)
    })
    it('survives a snapshot with null holes', () => {
      pads = [null, null]
      expect(() => coop.sample()).not.toThrow()
    })
  })

  // A raw pad (mapping '' with a non-canonical axis count -- the `pad` helper's
  // default 10 axes), i.e. the desktop-Linux/evdev shape where a one-axis hat is
  // real. Formerly the 8bitdo special case; the Zero 2 is nothing special here,
  // it is just a pad that reaches this shape on desktop.
  describe('a raw pad with a one-axis hat (desktop Linux shape)', () => {
    const zero2 = { id: '8BitDo Zero 2 gamepad', mapping: '' }
    it('joins on a face button even without standard mapping', () => {
      pads = [pad(0, { ...zero2, buttons: press(0) })]
      expect(coop.sample().joins).toContain(0)
    })
    it('moves via the hat axis', () => {
      pads = [pad(0, { ...zero2, buttons: press(0) })]
      coop.sample()
      const axes: number[] = []
      axes[9] = -1 // hat up
      pads = [pad(0, { ...zero2, axes })]
      expect(coop.sample().inputs.get(0)!.moveY).toBe(-1)
    })
  })

  describe('debug snapshot for the overlay', () => {
    it('lists a connected pad with its assigned slot', () => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
      const d = coop.debug()
      expect(d).toContainEqual(expect.objectContaining({ padIndex: 0, slot: 0 }))
    })
    it('shows an unassigned pad with a null slot', () => {
      pads = [pad(0)]
      coop.sample()
      expect(coop.debug()[0].slot).toBe(null)
    })
  })

  // #4: touch controls hide when a controller is actually driving.
  describe('anyPadActive — the show/hide-touch decision', () => {
    const dp = (slot: number | null): CoopDebugPad =>
      ({ padIndex: 0, id: 'x', slot, state: {} as CoopDebugPad['state'] })
    it('is false with no pads', () => {
      expect(anyPadActive([])).toBe(false)
    })
    it('is false for a connected-but-unjoined pad (null slot)', () => {
      expect(anyPadActive([dp(null)])).toBe(false)
    })
    it('is true once any pad has joined a slot', () => {
      expect(anyPadActive([dp(null), dp(0)])).toBe(true)
    })
    it('reflects a real join: unassigned → hidden-off, pressing join → hidden-on', () => {
      pads = [pad(0)]
      coop.sample()
      expect(anyPadActive(coop.debug())).toBe(false)
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
      expect(anyPadActive(coop.debug())).toBe(true)
    })
  })

  // End-to-end over the real live path that shipped the bug:
  // sample() → readPad(p, padProfile(p)) → toCmd() → InputCmd. Chromium on
  // Android reports mapping '' for many pads, which resolves to the permissive
  // profile and its speculative hatAxis: 9 — an axis a 4-axis pad does not
  // have. That used to decode as a permanent "down".
  describe('an Android-style pad (mapping "", 4 axes) does not walk south on its own', () => {
    const androidPad = (over: { buttons?: boolean[]; axes?: number[] } = {}) =>
      pad(0, { id: 'Xbox Wireless Controller', mapping: '', axisCount: 4, ...over })

    beforeEach(() => {
      pads = [androidPad({ buttons: press(0) })]
      coop.sample()
    })

    it('feeds no movement at all while the pad sits idle', () => {
      pads = [androidPad()]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.moveX).toBe(0)
      expect(cmd.moveY).toBe(0)
    })

    it('feeds stick Y through instead of a phantom +Y', () => {
      pads = [androidPad({ axes: [0, -0.9] })]
      expect(coop.sample().inputs.get(0)!.moveY).toBeCloseTo(-0.9)
    })

    it('does not pin aim southward when idle (aim-where-you-move reads moveY)', () => {
      pads = [androidPad()]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimY).not.toBe(1)
    })
  })

  /**
   * Bug 2, end-to-end over the same live path — because bug 1 shipped despite
   * readPad-level tests, and toCmd's selectAim(moveX, moveY, aimX, aimY) couples
   * move and aim, so only the whole path proves the InputCmd is clean.
   *
   * A raw pad (mapping '', a non-canonical axis count) whose axes 2/3 are analog
   * triggers resting at -1: hypot(-1,-1) = 1.41 > the 0.5 aim-fire threshold, so
   * an untouched pad used to attack forever and aim pinned up-left.
   */
  describe('a raw pad with triggers on axes 2/3 does not shoot on its own', () => {
    // 8 axes => not the canonical 4 => the raw profile, aimAxes null.
    const rawPad = (over: { buttons?: boolean[]; axes?: number[] } = {}) =>
      pad(0, { id: 'Some Generic USB Joystick', mapping: '', axisCount: 8, ...over })

    beforeEach(() => {
      pads = [rawPad({ buttons: press(0) })]
      coop.sample()
    })

    it('feeds no attack while the pad sits idle with its triggers resting at -1', () => {
      pads = [rawPad({ axes: [0, 0, -1, -1] })]
      expect(coop.sample().inputs.get(0)!.attack).toBe(false)
    })

    it('feeds no aim at all from the resting triggers', () => {
      pads = [rawPad({ axes: [0, 0, -1, -1] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimX).toBe(0)
      expect(cmd.aimY).toBe(0)
    })

    // The full idle contract: an untouched pad must produce a completely inert
    // InputCmd. This is the assertion that would have caught both shipped bugs.
    it('feeds a completely inert InputCmd while idle — no move, no aim, no attack', () => {
      pads = [rawPad({ axes: [0, 0, -1, -1] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.moveX).toBe(0)
      expect(cmd.moveY).toBe(0)
      expect(cmd.aimX).toBe(0)
      expect(cmd.aimY).toBe(0)
      expect(cmd.attack).toBe(false)
    })

    // Triggers report 0 until first touched, then rest at -1 -- so connect-time
    // resting-value sampling would have sampled a lie. Both states must be inert.
    it.each([
      ['untouched, still reporting 0', 0],
      ['touched once, now resting at -1', -1],
    ])('stays inert with triggers %s', (_label, rest) => {
      pads = [rawPad({ axes: [0, 0, rest, rest] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.attack).toBe(false)
      expect(cmd.aimX).toBe(0)
      expect(cmd.aimY).toBe(0)
    })

    it('still aims where the player moves, so the pad is not disarmed', () => {
      pads = [rawPad({ axes: [0, -0.9, -1, -1] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.moveY).toBeCloseTo(-0.9)
      expect(cmd.aimY).toBeCloseTo(-0.9) // selectAim falls back to the move vector
      expect(cmd.attack).toBe(false)
    })

    it('still attacks from the attack button with the triggers resting at -1', () => {
      pads = [rawPad({ buttons: press(0), axes: [0, 0, -1, -1] })]
      expect(coop.sample().inputs.get(0)!.attack).toBe(true)
    })
  })

  /**
   * The other half of trusting the canonical shape, end-to-end: a real Android
   * pad must KEEP twin-stick aim. Chromium puts triggers on buttons 6/7 there, so
   * axes 2/3 are the right stick (or zero-filled) and are safe to read.
   */
  describe('a canonical pad (mapping "", 4 axes) keeps twin-stick aim end-to-end', () => {
    const canonPad = (over: { buttons?: boolean[]; axes?: number[] } = {}) =>
      pad(0, { id: 'Xbox Wireless Controller', mapping: '', axisCount: 4, ...over })

    beforeEach(() => {
      pads = [canonPad({ buttons: press(0) })]
      coop.sample()
    })

    it('feeds right-stick aim through to the InputCmd without firing', () => {
      pads = [canonPad({ axes: [0, 0, 0.9, -0.8] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.aimX).toBeCloseTo(0.9)
      expect(cmd.aimY).toBeCloseTo(-0.8)
      expect(cmd.attack).toBe(false)
    })

    it('fires from L2 (canonical button 6) while aiming with the right stick', () => {
      const b: boolean[] = []
      b[6] = true
      pads = [canonPad({ buttons: b, axes: [0, 0, 0.9, -0.8] })]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.attack).toBe(true)
      expect(cmd.aimX).toBeCloseTo(0.9)
    })

    it('feeds d-pad movement from canonical buttons 12-15, where Chromium puts the hat', () => {
      pads = [canonPad({ buttons: press(12) })]
      expect(coop.sample().inputs.get(0)!.moveY).toBe(-1)
    })

    it('feeds a completely inert InputCmd while idle', () => {
      pads = [canonPad()]
      const cmd = coop.sample().inputs.get(0)!
      expect(cmd.moveX).toBe(0)
      expect(cmd.moveY).toBe(0)
      expect(cmd.aimX).toBe(0)
      expect(cmd.aimY).toBe(0)
      expect(cmd.attack).toBe(false)
    })
  })
})
