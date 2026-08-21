import { describe, expect, it, vi } from 'vitest'
import {
  createWebUpdater,
  isCriticalAsset,
  isNewerBuild,
  parseVersionPayload,
  precachePath,
  verifyPrecacheIntegrity,
  type HttpProbe,
  type PrecacheEntry,
  type StagedWorker,
  type WebUpdaterDeps,
} from './webUpdate'

// The property under test is NOT "does it update". It is "can it EVER swap to a
// partial or wrong set". Under offline-first a bad swap is not a transient
// glitch: the service worker keeps serving that broken combination forever,
// with no network to correct it and no recovery path for someone in a tent.
//
// So every case below is adversarial, and every one asserts the same two
// things: the update did NOT go live, and the old version was left completely
// untouched (no skipWaiting handed over, no reload).

const JSON_OK = (body: string): HttpProbe => ({ ok: true, status: 200, contentType: 'application/json', body })

/** What the SPA fallback actually returns for a path that does not exist:
 * status 200, text/html, the app shell. `res.ok` is true. It proves nothing. */
const SPA_FALLBACK: HttpProbe = {
  ok: true,
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html><head><title>Sporefall Station</title></head><body></body></html>',
}

const manifest = (version: string): string => JSON.stringify({ ok: true, current: { version, url: `/ota/${version}.zip` } })

/** A precache that looks like a real, healthy build. */
const HEALTHY: readonly PrecacheEntry[] = [
  { url: 'https://sporefall.example/index.html?__WB_REVISION__=abc123', contentType: 'text/html; charset=utf-8' },
  { url: 'https://sporefall.example/assets/index-9f2a1c.js', contentType: 'application/javascript' },
  { url: 'https://sporefall.example/assets/index-4b7e01.css', contentType: 'text/css' },
  { url: 'https://sporefall.example/icons/icon-192.png', contentType: 'image/png' },
]

interface Harness {
  readonly deps: WebUpdaterDeps
  readonly worker: StagedWorker & { readonly messages: unknown[] }
  readonly reload: ReturnType<typeof vi.fn>
  readonly checkForWorker: ReturnType<typeof vi.fn>
}

const harness = (over: Partial<WebUpdaterDeps> & { installed?: boolean } = {}): Harness => {
  const messages: unknown[] = []
  const worker = {
    messages,
    postMessage: (m: unknown) => void messages.push(m),
  }
  const reload = vi.fn()
  const checkForWorker = vi.fn(async () => {})
  const deps: WebUpdaterDeps = {
    probe: async () => JSON_OK(manifest('900')),
    checkForWorker,
    waiting: () => (over.installed === false ? null : worker),
    precacheEntries: async () => HEALTHY,
    reload,
    appVersion: '899',
    ...over,
  }
  return { deps, worker, reload, checkForWorker }
}

/** The invariant every adversarial case must end on. */
const expectOldVersionIntact = (h: Harness): void => {
  expect(h.worker.messages, 'must never hand over to a worker it has not verified').toEqual([])
  expect(h.reload, 'must never reload').not.toHaveBeenCalled()
}

// ---------------------------------------------------------------------------

describe('parseVersionPayload — content is checked, never status', () => {
  it('rejects the SPA fallback even though it returns 200', () => {
    // wrangler.jsonc: not_found_handling "single-page-application". A missing
    // version file is served as index.html with a 200. Trusting `ok` here would
    // read a version out of an HTML page.
    expect(parseVersionPayload(SPA_FALLBACK)).toEqual({ kind: 'unavailable', why: 'not-json' })
  })

  it('rejects HTML that lies about its content-type', () => {
    expect(parseVersionPayload({ ...SPA_FALLBACK, contentType: 'application/json' })).toEqual({
      kind: 'unavailable',
      why: 'unparseable',
    })
  })

  it('rejects a captive-portal style interception', () => {
    expect(parseVersionPayload({ ok: true, status: 200, contentType: 'text/plain', body: 'Sign in to WiFi' })).toEqual({
      kind: 'unavailable',
      why: 'not-json',
    })
  })

  it.each([
    ['no body at all', ''],
    ['a bare JSON array', '[]'],
    ['null', 'null'],
    ['the manifest without a current', '{"ok":true}'],
    ['a current that is a string', '{"current":"42"}'],
    ['a version that is a number', '{"current":{"version":42}}'],
  ])('rejects %s', (_label, body) => {
    const probe = parseVersionPayload(JSON_OK(body))
    expect(probe.kind).toBe('unavailable')
  })

  it('rejects the worker sentinel for "nothing published yet"', () => {
    expect(parseVersionPayload(JSON_OK(manifest('builtin')))).toEqual({
      kind: 'unavailable',
      why: 'no-published-build',
    })
  })

  it('rejects a version field containing markup', () => {
    expect(parseVersionPayload(JSON_OK('{"current":{"version":"<!doctype html>"}}'))).toEqual({
      kind: 'unavailable',
      why: 'implausible-version',
    })
  })

  it('rejects a non-2xx before looking at anything else', () => {
    expect(parseVersionPayload({ ok: false, status: 503, contentType: 'application/json', body: manifest('901') })).toEqual(
      { kind: 'unavailable', why: 'http-error' },
    )
  })

  it('reads a real manifest', () => {
    expect(parseVersionPayload(JSON_OK(manifest('903')))).toEqual({ kind: 'version', version: '903' })
  })
})

describe('isNewerBuild', () => {
  it('spots a new build', () => expect(isNewerBuild('904', '903')).toBe(true))
  it('is quiet when they match', () => expect(isNewerBuild('903', '903')).toBe(false))
  it('never updates an unversioned dev build into a loop', () => expect(isNewerBuild('903', 'dev')).toBe(false))
  it('treats a dirty local build as different, not equal', () => expect(isNewerBuild('903', '903+')).toBe(true))
})

describe('precachePath', () => {
  it('strips origin and workbox revision query', () => {
    expect(precachePath('https://sporefall.example/index.html?__WB_REVISION__=abc')).toBe('/index.html')
  })
  it('leaves an already-relative path alone', () => expect(precachePath('/assets/a.js')).toBe('/assets/a.js'))
})

describe('isCriticalAsset', () => {
  it('covers everything the app cannot boot without', () => {
    for (const url of ['/assets/index-9f2a1c.js', '/assets/index-4b7e01.css', '/index.html', '/manifest.webmanifest']) {
      expect(isCriticalAsset(url), url).toBe(true)
    }
  })

  it('leaves art out, so one odd content-type cannot stall updates forever', () => {
    // A bad theme file is a missing sprite. A bad entry script is a dead app.
    // Blocking every future update on the former would be the worse bug.
    for (const url of ['/themes/swampspace/tiles.png', '/sprites/city/thug.png', '/icons/icon-192.png']) {
      expect(isCriticalAsset(url), url).toBe(false)
    }
  })

  it('sees through the workbox revision query', () => {
    expect(isCriticalAsset('https://x/index.html?__WB_REVISION__=abc')).toBe(true)
  })
})

describe('verifyPrecacheIntegrity — the SPA fallback cached under an asset URL', () => {
  it('catches index.html stored where the entry script should be', () => {
    // THE catastrophe. A missing /assets/*.js does not 404 under the SPA
    // fallback — it returns the app shell with a 200, workbox caches it happily
    // and `install` SUCCEEDS. Swapping into that bundle would brick the app
    // permanently, because there is no network to correct it from.
    const poisoned: PrecacheEntry[] = [
      ...HEALTHY.filter((e) => !e.url.endsWith('.js')),
      { url: 'https://sporefall.example/assets/index-9f2a1c.js', contentType: 'text/html; charset=utf-8' },
    ]
    expect(verifyPrecacheIntegrity(poisoned)).toEqual({
      ok: false,
      why: 'wrong-content-type',
      offenders: ['/assets/index-9f2a1c.js'],
    })
  })

  it('catches a stylesheet served as the app shell', () => {
    const poisoned: PrecacheEntry[] = [
      ...HEALTHY.filter((e) => !e.url.endsWith('.css')),
      { url: 'https://sporefall.example/assets/index-4b7e01.css', contentType: 'text/html' },
    ]
    const result = verifyPrecacheIntegrity(poisoned)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ offenders: ['/assets/index-4b7e01.css'] })
  })

  it('counts a missing content-type against the entry rather than waving it through', () => {
    const nulled: PrecacheEntry[] = [
      ...HEALTHY.filter((e) => !e.url.endsWith('.js')),
      { url: 'https://sporefall.example/assets/index-9f2a1c.js', contentType: null },
    ]
    expect(verifyPrecacheIntegrity(nulled).ok).toBe(false)
  })

  it('never passes vacuously on an empty cache', () => {
    // "I checked every entry and found no problems" must not be a pass when
    // there were no entries — that is what a wiped or evicted cache looks like.
    expect(verifyPrecacheIntegrity([])).toEqual({ ok: false, why: 'precache-empty', offenders: [] })
  })

  it('never passes a set with no script in it at all', () => {
    const shellOnly = HEALTHY.filter((e) => !e.url.endsWith('.js'))
    expect(verifyPrecacheIntegrity(shellOnly)).toEqual({ ok: false, why: 'precache-has-no-script', offenders: [] })
  })

  it('passes a healthy build', () => expect(verifyPrecacheIntegrity(HEALTHY)).toEqual({ ok: true }))

  it('tolerates the revision query and mixed-case types', () => {
    expect(
      verifyPrecacheIntegrity([
        { url: '/assets/x-1.js?__WB_REVISION__=1', contentType: 'Text/JavaScript; charset=UTF-8' },
        { url: '/assets/x-1.css', contentType: 'TEXT/CSS' },
      ]),
    ).toEqual({ ok: true })
  })
})

describe('createWebUpdater — it cannot swap to a partial set', () => {
  it('stays silent and does nothing at all when offline', async () => {
    // Offline is the EXPECTED case for this game, not an error.
    const h = harness({ probe: () => Promise.reject(new TypeError('Failed to fetch')) })
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('unavailable')
    expect(updater.staged).toBe(false)
    expect(h.checkForWorker, 'offline must not even start a download').not.toHaveBeenCalled()
    updater.reportMoment('modePicker', 0)
    expectOldVersionIntact(h)
  })

  it('does not start a download when the version endpoint returns the SPA fallback', async () => {
    const h = harness({ probe: async () => SPA_FALLBACK })
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('unavailable')
    expect(h.checkForWorker).not.toHaveBeenCalled()
    updater.reportMoment('modePicker', 0)
    expectOldVersionIntact(h)
  })

  it('does nothing when already on the published build', async () => {
    const h = harness({ appVersion: '900' })
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('up-to-date')
    expect(h.checkForWorker).not.toHaveBeenCalled()
    expectOldVersionIntact(h)
  })

  it('INTERRUPTED DOWNLOAD: no waiting worker means nothing is staged', async () => {
    // A dropped connection makes workbox's install reject; the new worker is
    // discarded and never reaches `waiting`. The old worker keeps serving its
    // own complete precache.
    const h = harness({ installed: false })
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('downloading')
    expect(updater.staged).toBe(false)
    for (const moment of ['modePicker', 'lobby', 'floorTransition', 'runOver'] as const) {
      updater.reportMoment(moment, 0)
    }
    expectOldVersionIntact(h)
  })

  it('WRONG CONTENT: a 200 that returned the app shell never goes live', async () => {
    const poisoned: PrecacheEntry[] = [
      ...HEALTHY.filter((e) => !e.url.endsWith('.js')),
      { url: 'https://sporefall.example/assets/index-9f2a1c.js', contentType: 'text/html' },
    ]
    const h = harness({ precacheEntries: async () => poisoned })
    const updater = createWebUpdater(h.deps)
    const outcome = await updater.check()
    updater.reportMoment('floorTransition', 0)
    // Invariant first, so a regression reports what it BROKE rather than which
    // status string it returned.
    expectOldVersionIntact(h)
    expect(outcome).toBe('incomplete')
    expect(updater.staged).toBe(false)
  })

  it('SUBSET CACHED: a precache with no script in it never goes live', async () => {
    const h = harness({ precacheEntries: async () => HEALTHY.filter((e) => !e.url.endsWith('.js')) })
    const updater = createWebUpdater(h.deps)
    const outcome = await updater.check()
    updater.reportMoment('runOver', 0)
    expectOldVersionIntact(h)
    expect(outcome).toBe('incomplete')
  })

  it('QUOTA FAILURE: an unreadable cache is "do nothing", never "looks fine"', async () => {
    const h = harness({
      precacheEntries: () => Promise.reject(new DOMException('QuotaExceededError')),
    })
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('incomplete')
    expect(updater.staged).toBe(false)
    updater.reportMoment('modePicker', 0)
    expectOldVersionIntact(h)
  })

  it('EMPTY CACHE: an evicted precache never goes live', async () => {
    const h = harness({ precacheEntries: async () => [] })
    const updater = createWebUpdater(h.deps)
    const outcome = await updater.check()
    updater.reportMoment('lobby', 0)
    expectOldVersionIntact(h)
    expect(outcome).toBe('incomplete')
  })
})

describe('createWebUpdater — the swap, once everything is verified', () => {
  it('stages a verified update but waits for a safe moment', async () => {
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await expect(updater.check()).resolves.toBe('staged')
    expect(updater.staged).toBe(true)

    // Mid-run and paused: verified, downloaded, and still it must not fire.
    updater.reportMoment('inRun', 0)
    updater.reportMoment('paused', 0)
    expectOldVersionIntact(h)

    updater.reportMoment('floorTransition', 0)
    expect(h.worker.messages).toEqual([{ type: 'SKIP_WAITING' }])
    // Crucially NOT reloaded yet: the swap has been requested, not observed.
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('reloads only once the controller actually changed', async () => {
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await updater.check()
    updater.reportMoment('modePicker', 0)
    expect(h.reload).not.toHaveBeenCalled()
    updater.onControllerChange()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a controller change it did not ask for', async () => {
    // Another tab activating a worker must never yank this page mid-run.
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await updater.check()
    updater.onControllerChange()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('hands over exactly once however many moments are reported', async () => {
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await updater.check()
    updater.reportMoment('modePicker', 0)
    updater.reportMoment('lobby', 0)
    updater.reportMoment('floorTransition', 0)
    expect(h.worker.messages).toHaveLength(1)
  })

  it('does not hand over if the waiting worker vanished after verification', async () => {
    let present = true
    const h = harness({ waiting: () => (present ? { postMessage: () => {} } : null) })
    const updater = createWebUpdater(h.deps)
    await updater.check()
    present = false
    updater.reportMoment('modePicker', 0)
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('will not reload a player off a live co-op link', async () => {
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await updater.check()
    updater.reportMoment('floorTransition', 2)
    updater.reportMoment('runOver', 1)
    updater.reportMoment('lobby', 3)
    expectOldVersionIntact(h)
  })

  it('stages from the install event without a version check having run', async () => {
    // A worker can finish installing from the browser's own periodic update.
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await expect(updater.onWorkerInstalled()).resolves.toBe('staged')
    expect(updater.staged).toBe(true)
  })

  it('applies to a player already sitting in the menu when the download lands', async () => {
    // The player is at the mode picker, not moving. If the swap only ever
    // happened on the NEXT reported moment they could sit there indefinitely.
    const h = harness()
    const updater = createWebUpdater(h.deps)
    updater.reportMoment('modePicker', 0)
    expect(h.worker.messages).toEqual([]) // nothing staged yet
    await updater.check()
    expect(h.worker.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('does not apply on staging when the player is mid-run', async () => {
    const h = harness()
    const updater = createWebUpdater(h.deps)
    updater.reportMoment('inRun', 0)
    await updater.check()
    expectOldVersionIntact(h)
  })

  it('will not apply on staging before the app has said where the player is', async () => {
    // No reportMoment has ever been called. The default must be the unsafe one.
    const h = harness()
    const updater = createWebUpdater(h.deps)
    await updater.check()
    expect(updater.staged).toBe(true)
    expectOldVersionIntact(h)
  })

  it('does not re-verify once staged', async () => {
    const entries = vi.fn(async () => HEALTHY)
    const h = harness({ precacheEntries: entries })
    const updater = createWebUpdater(h.deps)
    await updater.check()
    await updater.check()
    await updater.onWorkerInstalled()
    expect(entries).toHaveBeenCalledTimes(1)
  })
})
