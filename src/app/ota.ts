import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { decideApply, type UpdateMoment } from './updatePolicy'
import type { CheckOutcome } from './webUpdate'

// Over-the-air (OTA) web-bundle updates for the INSTALLED ANDROID APP.
//
// The DOWNLOAD is done natively by @capgo/capacitor-updater with
// `autoUpdate: 'onlyDownload'` (configured in capacitor.config.ts): on each app
// launch, while online, it POSTs to our self-hosted manifest endpoint
// (/ota/check — the SAME endpoint the browser reads, see src/worker/ota.ts), and
// if a newer bundle exists it downloads it in the background. It is inherently
// non-blocking and offline-safe: if the check or download fails, the currently
// installed bundle just keeps running.
//
// Atomicity is the plugin's: it downloads the whole zip, verifies it, and only
// then registers it as a bundle. A partial download never becomes something the
// app can boot into, and `notifyAppReady()` below closes the loop — a bundle
// that fails to start is rolled back to the previous one automatically.
//
// What this file adds is WHEN it goes live — and, under 'onlyDownload', THAT IT
// GOES LIVE AT ALL. The plugin emits `updateAvailable` and deliberately does NOT
// set a next bundle, so this file is the ONLY installer: it captures the bundle
// id off that event and calls `set({ id })` at the next moment where a reload
// costs nothing, per the same policy the browser uses (updatePolicy.ts). So both
// platforms mean the same thing by "up to date" and neither asks the player to
// do anything.
//
// Do NOT reduce `set({ id })` to a bare `reload()`. With nothing staged
// natively, reload() re-renders the bundle ALREADY RUNNING and resolves
// successfully — downloading every update and installing none, forever, with no
// error to catch. This file and the `autoUpdate` line in capacitor.config.ts are
// one change; ota.test.ts fails if they are separated.

/** Applies a downloaded native bundle at a safe moment. Null on web/dev. */
export interface NativeUpdater {
  /** A verified bundle is downloaded and ready to be swapped in. */
  readonly staged: boolean
  /** The newer build the last check found published, or null if none was seen. */
  readonly latest: string | null
  /** Tell the updater where the player is. It applies if (and only if) it may. */
  reportMoment(moment: UpdateMoment, peers: number): void
  /**
   * Check NOW instead of waiting for the next launch, and wait (at most
   * `timeoutMs`) for a newer bundle to download. The same contract as
   * `WebUpdater.freshen`: `'staged'` means it is downloaded and will apply the
   * moment the policy allows.
   */
  freshen(timeoutMs: number): Promise<CheckOutcome | 'timeout'>
}

/**
 * What our /ota/check answers a phone that is already current (`decideOta` in
 * src/worker/ota.ts). Capgo's `getLatest()` rejects with it as the message, so
 * it is the one rejection that means "up to date" rather than "unreachable".
 */
export const OTA_UP_TO_DATE = 'up-to-date'

/**
 * Confirm this bundle booted successfully, so the native side keeps it instead
 * of auto-rolling-back to the previous one.
 *
 * No-op on the web and in dev live-reload — there is no native updater there,
 * and the config omits the plugin entirely when CAP_SERVER_URL is set.
 */
export const notifyOtaReady = async (): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // Plugin missing / offline — bundled version runs, no user-visible impact.
  }
}

/**
 * Start watching for a downloaded bundle. Returns null off-native.
 *
 * This is the whole installer, not an optimisation layered on one. Under
 * `autoUpdate: 'onlyDownload'` the plugin never sets a next bundle, so if this
 * path never fires the downloaded update never goes live at all — the app would
 * re-download it on every launch and keep running the old code forever.
 */
export const startNativeUpdates = (): NativeUpdater | null => {
  if (!Capacitor.isNativePlatform()) return null

  // The id of the downloaded bundle, from the last `updateAvailable`. This IS
  // the "staged" flag — `set()` cannot be called without an id, so deriving one
  // from the other makes a staged-but-nameless bundle unrepresentable.
  let stagedId: string | null = null
  let latest: string | null = null
  let applied = false
  /** `freshen()` callers waiting on the download they started. */
  const waiters: ((outcome: CheckOutcome) => void)[] = []
  const settle = (outcome: CheckOutcome): void => {
    for (const wake of waiters.splice(0)) wake(outcome)
  }
  // Most conservative default: never apply before the app has said where the
  // player is (mirrors webUpdate.ts).
  let moment: UpdateMoment = 'inRun'
  let peers = 0

  const applyIfAllowed = (): void => {
    const id = stagedId
    if (id === null) return
    if (!decideApply({ staged: true, applied, moment, peers }).apply) return
    applied = true
    // `set` makes this bundle current AND reloads, in one terminal call — which
    // is what this needs, since nothing may run after it: the JS context is
    // replaced. NOT `reload()`: with 'onlyDownload' no bundle is ever staged
    // natively, so a bare reload() would re-render the bundle already running.
    void CapacitorUpdater.set({ id }).catch(() => {
      // Could not swap: the current bundle keeps running and nothing was
      // applied, so a later safe moment may try again. Nothing to show anyone.
      applied = false
    })
  }

  // `updateAvailable` fires once the bundle is downloaded AND verified — never
  // mid-download, so there is no partial state to guard against here.
  void CapacitorUpdater.addListener('updateAvailable', (event) => {
    // Capture the id. The event is the only place it is offered, and it is the
    // only handle on the downloaded bundle — dropping it is precisely what made
    // the old bare-`reload()` version a silent no-op.
    stagedId = event.bundle.id
    // A player sitting in the menu when the download lands should not have to
    // move for it to apply.
    applyIfAllowed()
    settle('staged')
  }).catch(() => {
    // No plugin (dev live-reload) — updates simply never stage. Silent.
  })
  void CapacitorUpdater.addListener('downloadFailed', () => settle('incomplete')).catch(() => {})

  return {
    get staged(): boolean {
      return stagedId !== null
    },
    get latest(): string | null {
      return latest
    },
    reportMoment(next: UpdateMoment, nextPeers: number): void {
      moment = next
      peers = nextPeers
      applyIfAllowed()
    },
    async freshen(timeoutMs: number): Promise<CheckOutcome | 'timeout'> {
      if (stagedId !== null) return 'staged'
      // `getLatest` only asks. The download goes through the plugin's own
      // pipeline below, which ends in the same `updateAvailable` as a launch.
      try {
        const found = await CapacitorUpdater.getLatest()
        if (!found.url) return 'up-to-date'
        latest = found.version
      } catch (err) {
        return err instanceof Error && err.message === OTA_UP_TO_DATE ? 'up-to-date' : 'unavailable'
      }
      if (stagedId !== null) return 'staged'
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs)
        waiters.push((outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        })
        CapacitorUpdater.triggerUpdateCheck().then(
          (r) => {
            if (r.status === 'unavailable') settle('unavailable')
          },
          () => settle('unavailable'),
        )
      })
    },
  }
}
