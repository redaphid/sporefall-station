// @vitest-environment happy-dom
// Rebrand localStorage migration for feel settings (sor.settings →
// sporefall.settings), exercised through the real loadSettings/localStorage path
// so the wiring — not just the pure helper — is proven.

import { beforeEach, describe, expect, it } from 'vitest'
import { defaultFlags } from './featureFlags'
import { defaultSettings, loadSettings, type GameSettings } from './settings'

const NEW_KEY = 'sporefall.settings'
const OLD_KEY = 'sor.settings'

const nonDefault: GameSettings = {
  hapticsEnabled: false,
  hapticsIntensity: 0.25,
  effectsQuality: 'low',
  shaderFx: 'reduced',
  theme: 'swampspace',
  // defaultFlags() rather than a literal: clampSettings fills every registered
  // flag with its default, so a hardcoded {} would break each time one is added.
  flags: defaultFlags(),
  fullscreen: false,
}

// happy-dom's localStorage is method-less under current Node; give the module a
// real (in-memory) Storage so the load path is actually exercised.
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

beforeEach(() => localStorage.clear())

describe('settings — rebrand migration', () => {
  it('adopts pre-rebrand settings: legacy present, new absent → loaded + moved to the new key', () => {
    localStorage.setItem(OLD_KEY, JSON.stringify(nonDefault))
    expect(loadSettings()).toEqual(nonDefault)
    expect(localStorage.getItem(NEW_KEY)).toBe(JSON.stringify(nonDefault))
    expect(localStorage.getItem(OLD_KEY)).toBeNull()
  })

  it('prefers the new key when present; legacy is ignored', () => {
    localStorage.setItem(NEW_KEY, JSON.stringify(nonDefault))
    localStorage.setItem(OLD_KEY, JSON.stringify(defaultSettings()))
    expect(loadSettings()).toEqual(nonDefault)
    expect(localStorage.getItem(OLD_KEY)).not.toBeNull() // untouched
  })

  it('both absent → defaults', () => {
    expect(loadSettings()).toEqual(defaultSettings())
  })
})
