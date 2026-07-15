import { describe, it, expect, beforeEach } from 'vitest'
import { createGamepadCoop } from './gamepadCoop'

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
})
