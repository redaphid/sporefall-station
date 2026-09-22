// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { shouldRegisterSw, SW_UPDATE_INTERVAL_MS, type PwaEnv } from './pwa'

// The offline service worker is WEB-ONLY on purpose. Getting this guard wrong is
// not a cosmetic bug in either direction:
//   - registering on native => the SW precaches the old web bundle and silently
//     out-votes Capgo OTA, so phones can never update;
//   - refusing to register on the web => the PWA is online-only, which is the
//     exact regression this module exists to fix;
//   - registering from a BETA build => the registration asks for scope '/', so a
//     branch build would take over the live game for whoever reviewed it.
// So sweep the whole truth table rather than spot-checking the happy path.

const env = (o: Partial<PwaEnv>): PwaEnv => ({ native: false, supported: true, prod: true, beta: false, ...o })

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

  it('never registers from a beta build — scope \'/\' would hijack production', () => {
    expect(shouldRegisterSw(env({ beta: true }))).toBe(false)
  })

  it('exhaustively: true only when web AND supported AND prod AND not a beta', () => {
    const bools = [false, true]
    for (const native of bools) {
      for (const supported of bools) {
        for (const prod of bools) {
          for (const beta of bools) {
            expect(shouldRegisterSw({ native, supported, prod, beta })).toBe(!native && supported && prod && !beta)
          }
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
