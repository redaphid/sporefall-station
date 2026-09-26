import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REFRESH_CHECK_MS,
  REFRESH_DOWNLOAD_MS,
  REFRESH_READ_MS,
  REFRESH_RELOAD_GRACE_MS,
  refreshText,
  runRefresh,
  settledStatus,
  type RefreshDeps,
} from './refresh'
import { createWebUpdater, type CheckOutcome, type HttpProbe } from './webUpdate'

// The owner presses Refresh on a phone that may have no signal at all. The
// property that matters is that EVERY path ends on the picker within a bounded
// time, with the run saved first, and that the words on screen say what really
// happened. A never-resolving check is the realistic offline case, so it is
// tested as a first-class path, not an edge.

const RUNNING = '899'
const NEWER = '905'

interface Fake {
  readonly deps: RefreshDeps
  readonly log: string[]
  readonly shown: string[]
  readonly done: Promise<void>
}

const start = (freshen: RefreshDeps['freshen'], latest: () => string | null = () => null, over: Partial<RefreshDeps> = {}): Fake => {
  const log: string[] = []
  const shown: string[] = []
  const deps: RefreshDeps = {
    save: () => void log.push('save'),
    leave: () => void log.push('leave'),
    freshen: (ms) => {
      log.push('freshen')
      return freshen(ms)
    },
    latest,
    running: RUNNING,
    show: (text) => void shown.push(text),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    goToMenu: () => void log.push('menu'),
    ...over,
  }
  return { deps, log, shown, done: runRefresh(deps) }
}

const never = (): Promise<never> => new Promise(() => {})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runRefresh: every path ends on the picker', () => {
  it('saves and aims at the picker before it asks the network anything', async () => {
    const f = start(async () => 'up-to-date')
    await vi.advanceTimersByTimeAsync(REFRESH_READ_MS)
    await f.done

    expect(f.log).toEqual(['save', 'leave', 'freshen', 'menu'])
  })

  it('newer build: says which build, then leaves the reload to the updater', async () => {
    const f = start(async () => 'staged', () => NEWER)
    await vi.advanceTimersByTimeAsync(0)

    expect(f.shown).toEqual(['Checking for update…', `Updating to build ${NEWER}…`])
    await vi.advanceTimersByTimeAsync(REFRESH_RELOAD_GRACE_MS - 1)
    expect(f.log, 'went to the menu before the new build had its chance to reload').not.toContain('menu')
    await vi.advanceTimersByTimeAsync(1)
    await f.done
    expect(f.log.at(-1)).toBe('menu')
  })

  it('already current: names the running build', async () => {
    const f = start(async () => 'up-to-date')
    await vi.advanceTimersByTimeAsync(REFRESH_READ_MS)
    await f.done

    expect(f.shown).toEqual(['Checking for update…', `Already on build ${RUNNING}`])
    expect(f.log.at(-1)).toBe('menu')
  })

  it('offline, check rejected at once: says so and still leaves', async () => {
    const f = start(async () => 'unavailable')
    await vi.advanceTimersByTimeAsync(REFRESH_READ_MS)
    await f.done

    expect(f.shown.at(-1)).toBe('Offline, restarting on this build')
    expect(f.log.at(-1)).toBe('menu')
  })

  it('offline, check never answers: gives up after a few seconds, not forever', async () => {
    const f = start(never)
    await vi.advanceTimersByTimeAsync(REFRESH_CHECK_MS - 1)
    expect(f.shown).toEqual(['Checking for update…'])

    await vi.advanceTimersByTimeAsync(1 + REFRESH_READ_MS)
    await f.done
    expect(f.shown.at(-1)).toBe('Offline, restarting on this build')
    expect(f.log.at(-1)).toBe('menu')
    expect(REFRESH_CHECK_MS + REFRESH_READ_MS, 'offline must not feel like a hang').toBeLessThanOrEqual(8_000)
  })

  it('newer build found but the download stalls: bounded, then this build', async () => {
    const f = start(never, () => NEWER)
    await vi.advanceTimersByTimeAsync(REFRESH_CHECK_MS)
    expect(f.log, 'a found build must get its download window').not.toContain('menu')

    await vi.advanceTimersByTimeAsync(REFRESH_DOWNLOAD_MS + REFRESH_READ_MS)
    await f.done
    expect(f.shown.at(-1)).toBe('Update still downloading, restarting on this build')
    expect(f.log.at(-1)).toBe('menu')
  })

  it('update failed verification: says so and restarts on this build', async () => {
    const f = start(async () => 'incomplete', () => NEWER)
    await vi.advanceTimersByTimeAsync(REFRESH_READ_MS)
    await f.done

    expect(f.shown.at(-1)).toBe('Update failed, restarting on this build')
    expect(f.log.at(-1)).toBe('menu')
  })

  it('an updater that throws still ends on the picker', async () => {
    const f = start(() => Promise.reject(new Error('boom')))
    await expect(f.done).rejects.toThrow('boom')

    expect(f.log.at(-1)).toBe('menu')
  })

  it('a save that throws still ends on the picker', async () => {
    const f = start(async () => 'up-to-date', () => null, {
      save: () => {
        throw new Error('quota')
      },
    })
    await expect(f.done).rejects.toThrow('quota')

    expect(f.log).toEqual(['menu'])
  })
})

describe('settledStatus: one line for every outcome', () => {
  const outcomes: readonly (CheckOutcome | 'timeout' | 'no-answer')[] = [
    'up-to-date',
    'unavailable',
    'downloading',
    'staged',
    'incomplete',
    'already-staged',
    'timeout',
    'no-answer',
  ]

  it.each(outcomes)('%s has a non-empty status', (outcome) => {
    expect(refreshText(settledStatus(outcome, NEWER, RUNNING)).length).toBeGreaterThan(0)
  })

  it('only a staged update claims to be updating', () => {
    for (const outcome of outcomes) {
      const updating = settledStatus(outcome, NEWER, RUNNING).kind === 'updating'
      expect(updating, outcome).toBe(outcome === 'staged' || outcome === 'already-staged')
    }
  })

  it('falls back to a build-less line when the new build number is unknown', () => {
    expect(refreshText(settledStatus('already-staged', null, RUNNING))).toBe('Updating to the latest build…')
  })
})

describe('with the real web updater behind it', () => {
  const probe = async (): Promise<HttpProbe> => ({
    ok: true,
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { version: NEWER, url: `/ota/${NEWER}.zip` } }),
  })

  it('a newer build is handed over the moment Refresh reports it is leaving', async () => {
    const messages: unknown[] = []
    const reload = vi.fn()
    const updater = createWebUpdater({
      probe,
      checkForWorker: async () => {},
      waiting: () => ({ postMessage: (m) => void messages.push(m) }),
      precacheEntries: async () => [
        { url: 'https://s.example/assets/index-1.js', contentType: 'application/javascript' },
      ],
      reload,
      appVersion: RUNNING,
    })
    updater.reportMoment('paused', 0)
    const f = start(
      (ms) => updater.freshen(ms),
      () => updater.latest,
      { leave: () => updater.reportMoment('leaving', 0) },
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(messages, 'the waiting worker was never told to take over').toEqual([{ type: 'SKIP_WAITING' }])
    expect(f.shown).toContain(`Updating to build ${NEWER}…`)
    updater.onControllerChange()
    expect(reload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REFRESH_RELOAD_GRACE_MS)
    await f.done
  })

  it('stays paused-safe: without Refresh the same update does not apply', async () => {
    const messages: unknown[] = []
    const updater = createWebUpdater({
      probe,
      checkForWorker: async () => {},
      waiting: () => ({ postMessage: (m) => void messages.push(m) }),
      precacheEntries: async () => [
        { url: 'https://s.example/assets/index-1.js', contentType: 'application/javascript' },
      ],
      reload: vi.fn(),
      appVersion: RUNNING,
    })
    updater.reportMoment('paused', 0)
    expect(await updater.freshen(1000)).toBe('staged')
    expect(messages).toEqual([])
  })
})
