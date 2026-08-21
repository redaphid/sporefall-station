import { describe, expect, it } from 'vitest'
import {
  SW_CLEANUP_OUTDATED_CACHES,
  SW_GLOB_PATTERNS,
  SW_NAVIGATE_FALLBACK,
  SW_NAVIGATE_FALLBACK_DENYLIST,
  SW_RUNTIME_CACHING,
  SW_TAKEOVER,
} from './swConfig'

const ORIGIN = 'https://sporefall.hypnodroid.com'
const matches = (pathname: string): boolean =>
  SW_RUNTIME_CACHING.some((rule) => rule.urlPattern({ url: new URL(pathname, ORIGIN), sameOrigin: true }))
const denied = (pathname: string): boolean => SW_NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(pathname))

describe('the version endpoint is never cached by the service worker', () => {
  // If the SW ever answered /ota/check from cache, this client could never
  // observe a new version — the update feature would go quiet and stay quiet,
  // with nothing on screen to say so. Three independent ways it could happen,
  // so three assertions.

  it('is not matched by any runtime-caching rule', () => {
    expect(matches('/ota/check')).toBe(false)
    expect(matches('/ota/version.json')).toBe(false)
  })

  it('is not precached — no glob pattern reaches into ota/', () => {
    expect(SW_GLOB_PATTERNS.some((p) => p.includes('ota'))).toBe(false)
    // Nor via a catch-all that would sweep it up incidentally.
    expect(SW_GLOB_PATTERNS.some((p) => p === '**/*' || p.startsWith('**'))).toBe(false)
  })

  it('is excluded from the navigation fallback', () => {
    expect(denied('/ota/check')).toBe(true)
  })

  it('still caches the art it is supposed to', () => {
    expect(matches('/themes/swampspace/tiles.png')).toBe(true)
    expect(matches('/sprites/city/thug.png')).toBe(true)
  })

  it('never caches a cross-origin request', () => {
    expect(
      SW_RUNTIME_CACHING.some((rule) =>
        rule.urlPattern({ url: new URL('https://evil.example/themes/x.png'), sameOrigin: false }),
      ),
    ).toBe(false)
  })
})

describe('the navigation fallback never swallows a real download', () => {
  it('lets the APK short-links reach the network', () => {
    for (const path of ['/download', '/download/sporefall.apk', '/get']) {
      expect(denied(path), `${path} must not be answered with index.html`).toBe(true)
    }
  })

  it('keeps the multiplayer relay off the fallback', () => expect(denied('/ws/car')).toBe(true))

  it('still falls back for ordinary deep links', () => {
    expect(SW_NAVIGATE_FALLBACK).toBe('index.html')
    expect(denied('/')).toBe(false)
    expect(denied('/asset-showcase-not-really')).toBe(true) // prefix rule, intentional
  })
})

describe('the worker never takes over on its own', () => {
  // This is what keeps a half-old/half-new page from existing at all. With
  // skipWaiting the browser activates the new worker the instant it installs,
  // so an open tab runs OLD code against a NEW precache whose predecessor has
  // just been cleaned up underneath it. The swap must be the app's decision
  // (updatePolicy.ts), which means this stays false.
  it('does not skip waiting', () => expect(SW_TAKEOVER.skipWaiting).toBe(false))

  it('still claims clients, which is only reachable once it activates', () => {
    // Safe precisely BECAUSE skipWaiting is false: a worker that cannot
    // activate early cannot claim early. It earns its keep on a first-ever
    // install, where there is no previous worker and an unclaimed page would
    // not be offline-capable until the next launch.
    expect(SW_TAKEOVER.clientsClaim).toBe(true)
    expect(SW_TAKEOVER.skipWaiting, 'clientsClaim is only safe while this is false').toBe(false)
  })

  it('still drops superseded precaches once it DOES activate', () => {
    expect(SW_CLEANUP_OUTDATED_CACHES).toBe(true)
  })
})

describe('the offline shell is still complete', () => {
  it('precaches the app shell and the default theme chain', () => {
    // swampspace-hires falls back to swampspace, so offline play needs BOTH.
    for (const needed of [
      'index.html',
      'assets/**/*.{js,css}',
      'themes/swampspace-hires/**/*.{json,png,webp}',
      'themes/swampspace/**/*.{json,png,webp}',
    ]) {
      expect(SW_GLOB_PATTERNS).toContain(needed)
    }
  })

  it('leaves the 7 MB legacy sprite pack out of the install', () => {
    expect(SW_GLOB_PATTERNS.some((p) => p.startsWith('sprites/'))).toBe(false)
  })
})
