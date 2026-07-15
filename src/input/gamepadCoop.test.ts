import { describe, it, expect, beforeEach } from 'vitest'
import { anyPadActive, createGamepadCoop, cycleHotbar, type CoopDebugPad } from './gamepadCoop'
import { padProfile } from './padProfile'
import type { RenderView } from '../app/session'

const STD = padProfile({ id: 'x', mapping: 'standard' })

// A minimal render view carrying just the player entities' inventory/activeSlot,
// which is all the coop hotbar-cycle resolver reads.
const viewWith = (players: { playerId: number; inventory: { itemId: string; qty: number }[]; activeSlot: number }[]) =>
  ({ entities: players.map((p) => ({ playerCtl: p })) } as unknown as RenderView)

const btn = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })

const pad = (
  index: number,
  over: { id?: string; mapping?: string; buttons?: boolean[]; axes?: number[] } = {},
) =>
  ({
    index,
    id: over.id ?? 'Xbox Wireless Controller',
    mapping: over.mapping ?? 'standard',
    connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => btn(over.buttons?.[i] ?? false)),
    axes: Array.from({ length: 10 }, (_, i) => over.axes?.[i] ?? 0),
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

  describe('aim-to-fire parity: right stick fires attack', () => {
    beforeEach(() => {
      pads = [pad(0, { buttons: press(0) })]
      coop.sample()
    })
    it('sets attack when the right stick deflects past the fire threshold, no button', () => {
      pads = [pad(0, { axes: [0, 0, 0.9, 0] })]
      expect(coop.sample().inputs.get(0)!.attack).toBe(true)
    })
    it('leaves attack false for a centred right stick and no button', () => {
      pads = [pad(0)]
      expect(coop.sample().inputs.get(0)!.attack).toBe(false)
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

  describe('an 8bitdo Zero 2 in non-standard mode', () => {
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
})
