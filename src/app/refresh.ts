// Pause → Refresh: save the run, pull the newest build, land on the picker.
//
// The owner plays on a phone with no cell service, so every path ends on the
// picker within a bounded time, whatever the network does. The download and the
// swap belong to the platform updaters (webUpdate.ts, ota.ts) behind `Updates`;
// this file only sequences them and names what the player reads.

import type { CheckOutcome } from './webUpdate'

/** What the pause panel says while a Refresh runs. */
export type RefreshStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'updating'; readonly to: string | null }
  | { readonly kind: 'current'; readonly build: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'slow' }
  | { readonly kind: 'failed' }

export const refreshText = (s: RefreshStatus): string => {
  switch (s.kind) {
    case 'checking':
      return 'Checking for update…'
    case 'updating':
      return s.to === null ? 'Updating to the latest build…' : `Updating to build ${s.to}…`
    case 'current':
      return `Already on build ${s.build}`
    case 'offline':
      return 'Offline, restarting on this build'
    case 'slow':
      return 'Update still downloading, restarting on this build'
    case 'failed':
      return 'Update failed, restarting on this build'
  }
}

/** How a Refresh check ended. `'no-answer'`: the check itself never replied,
 * which is what a phone with no signal usually looks like. */
export type RefreshOutcome = CheckOutcome | 'timeout' | 'no-answer'

export const settledStatus = (outcome: RefreshOutcome, latest: string | null, running: string): RefreshStatus => {
  switch (outcome) {
    case 'staged':
    case 'already-staged':
      return { kind: 'updating', to: latest }
    case 'up-to-date':
      return { kind: 'current', build: running }
    case 'unavailable':
    case 'no-answer':
      return { kind: 'offline' }
    case 'timeout':
      return { kind: 'slow' }
    case 'incomplete':
    case 'downloading':
      return { kind: 'failed' }
  }
}

/** How long the check may go unanswered before we call it offline. */
export const REFRESH_CHECK_MS = 5_000
/** How long a known-newer build may take to download. */
export const REFRESH_DOWNLOAD_MS = 20_000
/** How long the final line stays up before the page leaves. */
export const REFRESH_READ_MS = 1_200
/** After `updating`, the updater reloads by itself; this is only the fallback. */
export const REFRESH_RELOAD_GRACE_MS = 8_000

export interface RefreshDeps {
  /** Write the run to the save slot now. A no-op for runs that are never saved. */
  readonly save: () => void
  /** Aim every reload at the picker and report the `leaving` update moment. */
  readonly leave: () => void
  readonly freshen: (timeoutMs: number) => Promise<CheckOutcome | 'timeout'>
  readonly latest: () => string | null
  /** The build running now (`APP_VERSION`). */
  readonly running: string
  readonly show: (text: string) => void
  readonly sleep: (ms: number) => Promise<void>
  /** Navigate to the picker on whatever build is running. */
  readonly goToMenu: () => void
}

/**
 * Run one Refresh to completion. Ends in `goToMenu()` on every path, including
 * a throw, unless an updater's own reload gets there first.
 */
export const runRefresh = async (d: RefreshDeps): Promise<void> => {
  // A probe that hangs never settles `freshen`. Give the check a few seconds to
  // find a newer build, then only a found build earns the download window.
  const deadline = async (): Promise<RefreshOutcome> => {
    await d.sleep(REFRESH_CHECK_MS)
    if (d.latest() === null) return 'no-answer'
    await d.sleep(REFRESH_DOWNLOAD_MS)
    return 'timeout'
  }
  try {
    d.save()
    d.leave()
    d.show(refreshText({ kind: 'checking' }))
    const outcome = await Promise.race([d.freshen(REFRESH_DOWNLOAD_MS), deadline()])
    const status = settledStatus(outcome, d.latest(), d.running)
    d.show(refreshText(status))
    await d.sleep(status.kind === 'updating' ? REFRESH_RELOAD_GRACE_MS : REFRESH_READ_MS)
  } finally {
    d.goToMenu()
  }
}
