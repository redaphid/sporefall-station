// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { shouldRegisterSw, SW_UPDATE_INTERVAL_MS, type PwaEnv } from './pwa'

// The offline service worker is WEB-ONLY on purpose. Getting this guard wrong is
// not a cosmetic bug in either direction:
//   - registering on native => the SW precaches the old web bundle and silently
//     out-votes Capgo OTA, so phones can never update;
//   - refusing to register on the web => the PWA is online-only, which is the
//     exact regression this module exists to fix.
// So sweep the whole truth table rather than spot-checking the happy path.

const env = (o: Partial<PwaEnv>): PwaEnv => ({ native: false, supported: true, prod: true, ...o })

describe('shouldRegisterSw', () => {
  it('registers for a production web build with service-worker support', () => {
    expect(shouldRegisterSw(env({}))).toBe(true)
  })

  it('never registers inside the native APK — OTA owns the bundle there', () => {
    expect(shouldRegisterSw(env({ native: true }))).toBe(false)
  })

  it('never registers in dev — a SW would serve yesterday’s bundle', () => {
    expect(shouldRegisterSw(env({ prod: false }))).toBe(false)
  })

  it('never registers where service workers are unavailable', () => {
    expect(shouldRegisterSw(env({ supported: false }))).toBe(false)
  })

  it('exhaustively: true only when web AND supported AND prod', () => {
    const bools = [false, true]
    for (const native of bools) {
      for (const supported of bools) {
        for (const prod of bools) {
          expect(shouldRegisterSw({ native, supported, prod })).toBe(!native && supported && prod)
        }
      }
    }
  })
})

describe('SW_UPDATE_INTERVAL_MS', () => {
  it('re-checks often enough that a deploy lands the same day, without polling hot', () => {
    expect(SW_UPDATE_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 1000)
    expect(SW_UPDATE_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})
