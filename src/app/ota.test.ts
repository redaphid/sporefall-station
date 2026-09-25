import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeUpdater } from './ota'
import { COOP_SAFE_MOMENTS, SAFE_MOMENTS, UPDATE_MOMENTS, type UpdateMoment } from './updatePolicy'

// src/app/ota.ts is the ONLY thing that installs a downloaded update on Android.
// The plugin is configured `autoUpdate: 'onlyDownload'` (capacitor.config.ts):
// it downloads, emits `updateAvailable`, and deliberately never sets a next
// bundle. So this file has to name the bundle it wants to run.
//
// The bug this suite exists to catch is silent. A bare `CapacitorUpdater.reload()`
// with nothing staged "simply reloads the current bundle" (Capgo's own docs),
// RESOLVES SUCCESSFULLY, and installs nothing — forever. No throw, no rejected
// promise, no symptom except an app that never changes, and a `.catch()` that
// never fires. A test that asked only "did we try to reload?" would pass on that
// bug. That is how it shipped. So every assertion below is about the BUNDLE ID,
// never about reload having been called.
//
// The other half is the negative, and it is the more important half: an update
// must never land mid-fight, behind a pause overlay, or while a co-op partner is
// on the link — reloading there takes their session down too. Those cases assert
// the plugin was not touched AT ALL, not merely that it was touched politely.

/** The part of Capgo's `UpdateAvailableEvent` that ota.ts consumes. */
interface UpdateAvailableLike {
  readonly bundle: { readonly id: string; readonly version: string }
}

const mocks = vi.hoisted(() => {
  const listeners: ((event: UpdateAvailableLike) => void)[] = []
  return {
    listeners,
    isNativePlatform: vi.fn((): boolean => true),
    notifyAppReady: vi.fn(async (): Promise<void> => {}),
    // The two id-carrying ways to make a downloaded bundle the running one:
    // `set` does it in a single terminal call, `next` + `reload` in two.
    set: vi.fn<(options: { id: string }) => Promise<void>>(async () => {}),
    next: vi.fn<(options: { id: string }) => Promise<void>>(async () => {}),
    // ...and the one that, on its own, installs nothing.
    reload: vi.fn(async (): Promise<void> => {}),
    addListener: vi.fn(
      async (event: string, listener: (e: UpdateAvailableLike) => void): Promise<{ remove: () => Promise<void> }> => {
        if (event === 'updateAvailable') listeners.push(listener)
        return { remove: async (): Promise<void> => {} }
      },
    ),
  }
})

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: mocks.isNativePlatform } }))
vi.mock('@capgo/capacitor-updater', () => ({ CapacitorUpdater: mocks }))

const { notifyOtaReady, startNativeUpdates } = await import('./ota')

const BUNDLE = 'bundle-7f3a91'
const LATER_BUNDLE = 'bundle-c0ffee'

/** Start the updater, failing loudly instead of silently testing nothing. */
const startUpdater = (): NativeUpdater => {
  const updater = startNativeUpdates()
  if (updater === null) throw new Error('startNativeUpdates returned null on a native platform')
  return updater
}

/** Fire `updateAvailable` exactly as the native side does once a download verifies. */
const emitUpdateAvailable = (id: string): void => {
  expect(mocks.listeners.length, 'ota.ts never subscribed to updateAvailable').toBeGreaterThan(0)
  for (const listener of mocks.listeners) listener({ bundle: { id, version: '1.2.3' } })
}

/**
 * Every bundle id the app actually asked the plugin to make current.
 *
 * `set({ id })` names it in one call; `next({ id })` followed by `reload()` names
 * it in two. Both are legitimate implementations. A bare `reload()` carries no id
 * and lands in NEITHER list — which is the entire point of measuring installs this
 * way: an install that cannot name its bundle did not happen.
 */
const appliedBundleIds = (): readonly string[] => [
  ...mocks.set.mock.calls.map(([options]) => options.id),
  ...(mocks.reload.mock.calls.length > 0 ? mocks.next.mock.calls.map(([options]) => options.id) : []),
]

/** Any attempt to disturb the running bundle, named or not. For "did NOTHING happen". */
const swapAttempts = (): number =>
  mocks.set.mock.calls.length + mocks.next.mock.calls.length + mocks.reload.mock.calls.length

/** Moments that are unsafe solo, derived from the policy so a NEW moment is covered
 *  the day it is added rather than the day someone remembers to update this file. */
const SOLO_UNSAFE = UPDATE_MOMENTS.filter((m) => !(SAFE_MOMENTS as readonly UpdateMoment[]).includes(m))
const COOP_UNSAFE = UPDATE_MOMENTS.filter((m) => !(COOP_SAFE_MOMENTS as readonly UpdateMoment[]).includes(m))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.length = 0
  mocks.isNativePlatform.mockReturnValue(true)
})

describe('installing a downloaded bundle', () => {
  it('captures the id from updateAvailable and installs THAT bundle', () => {
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 0)

    expect(appliedBundleIds()).toEqual([BUNDLE])
  })

  it('never asks for a reload it cannot name a bundle for', () => {
    // Capgo, on reload(): "If no update is pending (no call to `next`), this
    // simply reloads the current bundle." Under 'onlyDownload' nothing is EVER
    // pending unless we stage it ourselves, so an unnamed reload is a no-op
    // wearing the costume of a successful update.
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 0)

    const named = mocks.set.mock.calls.length + mocks.next.mock.calls.length
    expect(
      named,
      'reloaded without staging a bundle id: that re-renders the bundle already running and installs nothing',
    ).toBeGreaterThan(0)
  })

  it('applies as soon as the download lands if the player is already in a menu', () => {
    const updater = startUpdater()
    updater.reportMoment('modePicker', 0)
    expect(swapAttempts(), 'applied with nothing downloaded').toBe(0)

    emitUpdateAvailable(BUNDLE)
    expect(appliedBundleIds()).toEqual([BUNDLE])
  })

  it('applies at the mode picker even with peers connected, exactly as the policy allows', () => {
    // modePicker is the one moment on COOP_SAFE_MOMENTS. Asserting it applies
    // stops anyone "fixing" a co-op bug by refusing every peers > 0 case.
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 2)

    expect(appliedBundleIds()).toEqual([BUNDLE])
  })

  it('reports staged only once a bundle is actually downloaded', () => {
    const updater = startUpdater()
    expect(updater.staged).toBe(false)

    emitUpdateAvailable(BUNDLE)
    expect(updater.staged).toBe(true)
  })
})

describe('refusing to apply at an unsafe moment', () => {
  it('does not touch the plugin before anything is downloaded', () => {
    const updater = startUpdater()
    updater.reportMoment('modePicker', 0)

    expect(swapAttempts()).toBe(0)
  })

  it('does not apply on the download alone, before being told where the player is', () => {
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)

    expect(updater.staged, 'the bundle is downloaded, so it should be waiting').toBe(true)
    expect(swapAttempts(), 'applied without ever learning the player was somewhere safe').toBe(0)
  })

  it.each(SOLO_UNSAFE)('solo at %s: leaves the plugin completely alone', (moment) => {
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment(moment, 0)

    expect(swapAttempts(), `reloaded the player during ${moment}`).toBe(0)
  })

  it.each(COOP_UNSAFE)('with a co-op peer on the link at %s: leaves the plugin completely alone', (moment) => {
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment(moment, 1)

    expect(swapAttempts(), `reloaded during ${moment} with peers connected, taking their session with it`).toBe(0)
  })

  it('never applies across a whole unsafe session, however many moments pass', () => {
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    for (const moment of SOLO_UNSAFE) {
      updater.reportMoment(moment, 0)
      emitUpdateAvailable(BUNDLE)
    }

    expect(swapAttempts()).toBe(0)
  })
})

describe('applying at most once', () => {
  it('cannot be driven into a reload loop by a re-announced bundle', () => {
    // The already-downloaded bundle is re-announced on EVERY foreground check.
    // Each repeat at a safe moment would otherwise spend another webview reload.
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 0)
    expect(appliedBundleIds()).toEqual([BUNDLE])

    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 0)
    emitUpdateAvailable(LATER_BUNDLE)
    updater.reportMoment('lobby', 0)

    expect(appliedBundleIds(), 'applied twice; every extra apply is another webview reload').toEqual([BUNDLE])
    expect(swapAttempts()).toBe(1)
  })

  it('lets a later safe moment retry if the swap itself failed', async () => {
    // The swap is the one step that can fail loudly (bundle deleted, no space).
    // Failing it must not burn the update: nothing was applied, so try again.
    mocks.set.mockRejectedValueOnce(new Error('bundle vanished'))
    const updater = startUpdater()
    emitUpdateAvailable(BUNDLE)
    updater.reportMoment('modePicker', 0)

    // Let the rejection's .catch() run before deciding the update is still pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    updater.reportMoment('modePicker', 0)
    expect(appliedBundleIds()).toEqual([BUNDLE, BUNDLE])
  })
})

describe('off-native', () => {
  it('does nothing at all in the browser or dev live-reload', () => {
    mocks.isNativePlatform.mockReturnValue(false)

    expect(startNativeUpdates()).toBeNull()
    expect(mocks.addListener).not.toHaveBeenCalled()
    expect(swapAttempts()).toBe(0)
  })

  it('notifyOtaReady stays silent when there is no plugin to tell', async () => {
    mocks.isNativePlatform.mockReturnValue(false)

    await expect(notifyOtaReady()).resolves.toBeUndefined()
    expect(mocks.notifyAppReady).not.toHaveBeenCalled()
  })
})

describe('confirming the boot', () => {
  it('tells the native side this bundle started, so it is not rolled back', async () => {
    await notifyOtaReady()

    expect(mocks.notifyAppReady).toHaveBeenCalledTimes(1)
  })

  it('swallows a failure to confirm rather than breaking boot', async () => {
    mocks.notifyAppReady.mockRejectedValueOnce(new Error('plugin not implemented'))

    await expect(notifyOtaReady()).resolves.toBeUndefined()
  })
})

describe('the config half of the pair', () => {
  // Nothing else in the suite reads capacitor.config.ts, which is exactly how a
  // config-only change once shipped green. `set({ id })` above is correct ONLY
  // because the plugin is told never to stage anything itself; flip this back to
  // `true` and the plugin becomes a second installer that swaps on backgrounding,
  // at precisely the moments updatePolicy.ts exists to refuse.
  interface LoadedConfig {
    readonly plugins?: { readonly CapacitorUpdater?: { readonly autoUpdate?: unknown; readonly updateUrl?: unknown } }
    readonly server?: { readonly url?: string }
  }

  const loadConfig = async (serverUrl?: string): Promise<LoadedConfig> => {
    vi.resetModules()
    vi.stubEnv('CAP_SERVER_URL', serverUrl)
    const loaded = await import('../../capacitor.config')
    return loaded.default as LoadedConfig
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('tells the plugin to download only and never stage, in production builds', async () => {
    const config = await loadConfig()

    expect(config.plugins?.CapacitorUpdater?.autoUpdate).toBe('onlyDownload')
    expect(config.plugins?.CapacitorUpdater?.updateUrl, 'no updateUrl: updates would hit Capgo SaaS').toBeTruthy()
  })

  it('omits the updater entirely under dev live-reload', async () => {
    const config = await loadConfig('http://192.168.1.184:5173')

    expect(config.plugins, 'the updater must never fight the dev server').toBeUndefined()
    expect(config.server?.url).toBe('http://192.168.1.184:5173')
  })
})
