// @vitest-environment happy-dom
// The user button-remap overlay: swap semantics, validation, persistence, and
// the read-path overlay itself. This layer is the ONLY way user config touches
// pad reading, so the adversarial cases (tampered localStorage, exotic
// indices, axis smuggling) matter as much as the happy path.

import { beforeEach, describe, expect, it } from 'vitest'
import { padProfile } from './padProfile'
import {
  ACTION_LABELS,
  bindButton,
  bindingLabel,
  buttonName,
  clampButtonMap,
  defaultButtonMap,
  getButtonMap,
  loadButtonMap,
  PAD_ACTIONS,
  remapProfile,
  resetAction,
  resetButtonMapCacheForTest,
  saveButtonMap,
  setButtonMap,
  setPadCapture,
  type ButtonMap,
} from './remap'

const STD = padProfile({ id: 'x', mapping: 'standard', axes: [] })
const RAW = padProfile({ id: 'x', mapping: '', axes: Array.from({ length: 8 }, () => 0) })

// happy-dom's localStorage is method-less under current Node; give the module
// a real (in-memory) Storage so persistence is actually exercised.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

beforeEach(() => {
  localStorage.clear()
  resetButtonMapCacheForTest()
  setPadCapture(false)
})

describe('the action list', () => {
  it('enumerates exactly the remappable actions from the real map (no join, no dpad)', () => {
    expect([...PAD_ACTIONS].sort()).toEqual(
      ['attack', 'hotbarNext', 'hotbarPrev', 'interact', 'pause', 'roll', 'special', 'throw'].sort(),
    )
  })
  it('every action has a UI label', () => {
    for (const a of PAD_ACTIONS) expect(ACTION_LABELS[a]).toBeTruthy()
  })
  it('defaults mirror the documented layout (A/RB/L2/R2 attack, B interact, Start pause, …)', () => {
    expect(defaultButtonMap()).toEqual({
      attack: [0, 5, 6, 7],
      interact: [1],
      special: [2, 3],
      roll: [4],
      pause: [9],
      throw: [8],
      hotbarPrev: [10],
      hotbarNext: [11],
    })
  })
  it('defaultButtonMap returns fresh copies (mutating one cannot poison the source)', () => {
    const a = defaultButtonMap()
    a.attack.push(99)
    expect(defaultButtonMap().attack).toEqual([0, 5, 6, 7])
  })
})

describe('bindButton — swap semantics', () => {
  it('binding a free (exotic) button just takes it', () => {
    const m = bindButton(defaultButtonMap(), 'roll', 17)
    expect(m.roll).toEqual([17])
    for (const a of PAD_ACTIONS) if (a !== 'roll') expect(m[a]).toEqual(defaultButtonMap()[a])
  })
  it("binding a button another action owns SWAPS: the other action inherits this one's old buttons", () => {
    const m = bindButton(defaultButtonMap(), 'attack', 1) // B is interact's
    expect(m.attack).toEqual([1])
    expect(m.interact).toEqual([0, 5, 6, 7]) // interact took attack's old set
  })
  it('swap works when the displaced action held several buttons', () => {
    const m = bindButton(defaultButtonMap(), 'interact', 5) // RB is one of attack's four
    expect(m.interact).toEqual([5])
    expect(m.attack).toEqual([1]) // attack took interact's old single button
  })
  it('swapping away from an UNBOUND action leaves the displaced action unbound', () => {
    let m = bindButton(defaultButtonMap(), 'pause', 8) // pause↔throw swap: throw gets [9]
    expect(m.throw).toEqual([9])
    m = bindButton(m, 'pause', 9) // rebind pause onto Start, which throw now owns
    expect(m.pause).toEqual([9])
    expect(m.throw).toEqual([8])
  })
  it('capturing Start for another action swaps pause onto the displaced buttons (never a silent duplicate)', () => {
    const m = bindButton(defaultButtonMap(), 'roll', 9)
    expect(m.roll).toEqual([9])
    expect(m.pause).toEqual([4]) // swap: pause took roll's old LB
  })
  it('pause CAN end up unbound (swap with an unbound action) — acceptable, gear still opens the panel', () => {
    let m = resetAction(bindButton(defaultButtonMap(), 'interact', 5), 'attack') // interact now unbound
    expect(m.interact).toEqual([])
    m = bindButton(m, 'interact', 9) // interact takes Start; pause inherits… nothing
    expect(m.interact).toEqual([9])
    expect(m.pause).toEqual([])
  })
  it('rebinding an action onto one of its own buttons narrows it to that button', () => {
    const m = bindButton(defaultButtonMap(), 'attack', 6)
    expect(m.attack).toEqual([6])
    expect(m.interact).toEqual([1]) // nothing else moved
  })
  it('rebinding an action to its sole existing button is a no-op (same reference)', () => {
    const base = defaultButtonMap()
    expect(bindButton(base, 'interact', 1)).toBe(base)
  })
  it('rejects non-integer, negative, and absurd indices unchanged', () => {
    const base = defaultButtonMap()
    expect(bindButton(base, 'attack', 1.5)).toBe(base)
    expect(bindButton(base, 'attack', -1)).toBe(base)
    expect(bindButton(base, 'attack', 64)).toBe(base)
    expect(bindButton(base, 'attack', NaN)).toBe(base)
  })
  it('is pure: the input map is never mutated', () => {
    const base = defaultButtonMap()
    bindButton(base, 'attack', 1)
    expect(base).toEqual(defaultButtonMap())
  })
  it('every action is reachable: each can be rebound and read back', () => {
    for (const a of PAD_ACTIONS) {
      const m = bindButton(defaultButtonMap(), a, 20)
      expect(m[a]).toEqual([20])
    }
  })
  it('after any single user bind, no button drives two actions (defaults aside, ownership stays single)', () => {
    for (const a of PAD_ACTIONS) {
      for (const b of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 25]) {
        const m = bindButton(defaultButtonMap(), a, b)
        const owners = PAD_ACTIONS.filter((x) => m[x].includes(b))
        expect(owners).toEqual([a])
      }
    }
  })
})

describe('resetAction', () => {
  it('restores the default; other actions keep only buttons the defaults do not reclaim', () => {
    let m = bindButton(defaultButtonMap(), 'attack', 1) // attack=[1], interact=[0,5,6,7]
    m = bindButton(m, 'interact', 17) // interact moves on to an exotic button
    m = resetAction(m, 'attack')
    expect(m.attack).toEqual([0, 5, 6, 7])
    expect(m.interact).toEqual([17]) // untouched — 17 is not one of attack's defaults
  })
  it('an action stripped to nothing by a reclaim shows as unbound', () => {
    let m = bindButton(defaultButtonMap(), 'interact', 5) // interact=[5], attack=[1]
    m = resetAction(m, 'attack') // attack reclaims 0/5/6/7 → interact loses its only button
    expect(m.attack).toEqual([0, 5, 6, 7])
    expect(m.interact).toEqual([])
  })
  it('is pure', () => {
    const m = bindButton(defaultButtonMap(), 'attack', 1)
    const snapshot = JSON.parse(JSON.stringify(m)) as ButtonMap
    resetAction(m, 'attack')
    expect(m).toEqual(snapshot)
  })
})

describe('clampButtonMap — hostile persisted data', () => {
  it.each([
    ['null', null],
    ['a string', 'attack=1'],
    ['a number', 7],
    ['an array', [1, 2, 3]],
    ['empty object (no version)', {}],
    ['wrong version', { v: 2, map: defaultButtonMap() }],
    ['version without map', { v: 1 }],
    ['map not an object', { v: 1, map: 'yes' }],
  ])('%s falls back to full defaults', (_name, raw) => {
    expect(clampButtonMap(raw)).toEqual(defaultButtonMap())
  })
  it('a MISSING action falls back to full defaults (all-or-nothing, no partial merge)', () => {
    const m = defaultButtonMap() as Partial<ButtonMap>
    delete m.pause
    expect(clampButtonMap({ v: 1, map: m })).toEqual(defaultButtonMap())
  })
  it.each([
    ['a float', [1.5]],
    ['a negative', [-1]],
    ['past the ceiling', [64]],
    ['a string index', ['1']],
    ['null entry', [null]],
    ['an object entry', [{}]],
    ['an oversized list', Array.from({ length: 17 }, (_, i) => i)],
    ['not an array', 5],
  ])('an action holding %s falls back to full defaults', (_name, bad) => {
    expect(clampButtonMap({ v: 1, map: { ...defaultButtonMap(), roll: bad } })).toEqual(defaultButtonMap())
  })
  it('accepts a valid user map verbatim, including exotic indices and unbound actions', () => {
    const user = { ...defaultButtonMap(), attack: [1], interact: [0, 5, 6, 7], pause: [], roll: [63] }
    expect(clampButtonMap({ v: 1, map: user })).toEqual(user)
  })
  it('dedupes repeats within one action', () => {
    expect(clampButtonMap({ v: 1, map: { ...defaultButtonMap(), roll: [4, 4, 4] } }).roll).toEqual([4])
  })
  it('there is no way to express an axis: only button indices exist in the schema', () => {
    // Adversarial shape a confused writer might produce — extra keys are ignored,
    // never merged into the map.
    const m = clampButtonMap({ v: 1, map: { ...defaultButtonMap(), aimAxes: [2, 3], moveAxes: [0, 1] } })
    expect('aimAxes' in m).toBe(false)
    expect('moveAxes' in m).toBe(false)
  })
})

describe('persistence round-trip', () => {
  it('save → load returns the same map', () => {
    const user = bindButton(defaultButtonMap(), 'attack', 1)
    saveButtonMap(user)
    expect(loadButtonMap()).toEqual(user)
  })
  it('loads defaults when nothing is stored', () => {
    expect(loadButtonMap()).toEqual(defaultButtonMap())
  })
  it('loads defaults from corrupt JSON', () => {
    localStorage.setItem('sporefall.padmap', '{not json')
    expect(loadButtonMap()).toEqual(defaultButtonMap())
  })
  it('loads defaults from valid-JSON garbage', () => {
    localStorage.setItem('sporefall.padmap', JSON.stringify({ v: 1, map: { attack: ['axis 2'] } }))
    expect(loadButtonMap()).toEqual(defaultButtonMap())
  })
  it('setButtonMap persists under the versioned key', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'attack', 1))
    const raw = JSON.parse(localStorage.getItem('sporefall.padmap')!)
    expect(raw.v).toBe(1)
    expect(raw.map.attack).toEqual([1])
  })
  it('getButtonMap picks up what a previous session stored', () => {
    localStorage.setItem('sporefall.padmap', JSON.stringify({ v: 1, map: bindButton(defaultButtonMap(), 'special', 30) }))
    resetButtonMapCacheForTest()
    expect(getButtonMap().special).toEqual([30])
  })
})

describe('persistence — rebrand migration (sor.padmap → sporefall.padmap)', () => {
  it('adopts a pre-rebrand remap: legacy present, new absent → loaded + moved to the new key', () => {
    const user = bindButton(defaultButtonMap(), 'attack', 1)
    localStorage.setItem('sor.padmap', JSON.stringify({ v: 1, map: user }))
    expect(loadButtonMap()).toEqual(user)
    expect(localStorage.getItem('sporefall.padmap')).not.toBeNull()
    expect(localStorage.getItem('sor.padmap')).toBeNull() // legacy reclaimed
  })

  it('prefers the new key; a stale sor.padmap is ignored', () => {
    const current = bindButton(defaultButtonMap(), 'special', 5)
    localStorage.setItem('sporefall.padmap', JSON.stringify({ v: 1, map: current }))
    localStorage.setItem('sor.padmap', JSON.stringify({ v: 1, map: bindButton(defaultButtonMap(), 'attack', 9) }))
    expect(loadButtonMap()).toEqual(current)
    expect(localStorage.getItem('sor.padmap')).not.toBeNull() // untouched
  })
})

describe('remapProfile — the read-path overlay', () => {
  it('with defaults, returns the profile object untouched (fast path)', () => {
    expect(remapProfile(STD)).toBe(STD)
  })
  it('overlays every remapped action onto the profile', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'attack', 1))
    const p = remapProfile(STD)
    expect(p.attack).toEqual([1])
    expect(p.interact).toEqual([0, 5, 6, 7])
  })
  it('never touches axes, dpad, or kind — remap cannot smuggle analog trust', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'attack', 1))
    for (const base of [STD, RAW]) {
      const p = remapProfile(base)
      expect(p.kind).toBe(base.kind)
      expect(p.moveAxes).toEqual(base.moveAxes)
      expect(p.aimAxes).toEqual(base.aimAxes) // raw stays null: no aim stick appears
      expect(p.hatAxis).toEqual(base.hatAxis)
      expect(p.dpad).toEqual(base.dpad)
    }
  })
  it('applies uniformly to every profile kind (one map for all pads)', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'roll', 17))
    expect(remapProfile(STD).roll).toEqual([17])
    expect(remapProfile(RAW).roll).toEqual([17])
  })
  it('reverts to the fast path after a reset to defaults', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'attack', 1))
    setButtonMap(defaultButtonMap())
    expect(remapProfile(STD)).toBe(STD)
  })
})

describe('button names', () => {
  it('names the canonical 16', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(buttonName)).toEqual([
      'A', 'B', 'X', 'Y', 'LB', 'RB', 'L2', 'R2', 'Back', 'Start', 'L3', 'R3',
    ])
    expect(buttonName(12)).toBe('D-Up')
    expect(buttonName(15)).toBe('D-Right')
  })
  it("falls back to 'Button N' for exotic indices", () => {
    expect(buttonName(16)).toBe('Button 16')
    expect(buttonName(42)).toBe('Button 42')
  })
  it('bindingLabel joins names and em-dashes an unbound action', () => {
    expect(bindingLabel([0, 5, 6, 7])).toBe('A · RB · L2 · R2')
    expect(bindingLabel([])).toBe('—')
  })
})
