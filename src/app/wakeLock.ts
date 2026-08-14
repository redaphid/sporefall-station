/**
 * Keep the screen on while a game is running.
 *
 * The asymmetry is the point: if a GUEST's screen sleeps, that guest freezes and
 * the others play on. If the HOST's screen sleeps, the authoritative sim stops
 * ticking and EVERY player freezes at once — which reads, to a room full of
 * people, as a total crash rather than a phone doing exactly what phones do.
 *
 * Screen Wake Lock (the web API) is used in preference to a native plugin: no
 * native rebuild, and the PWA/browser build gets it for free. It is absent on
 * older WebViews and on non-secure origins, and `request()` rejects outright when
 * the page is hidden or the OS is in battery saver. NONE of that may break the
 * game, so every path here is best-effort and silent — the worst case is exactly
 * today's behaviour.
 *
 * The lock is auto-released by the browser whenever the page is hidden, so
 * re-acquiring on `visibilitychange` is not an optimisation — without it the lock
 * is gone for good the first time the player takes a call or checks a message.
 */

export interface WakeLockHandle {
  /** Stop holding the screen awake and stop trying to re-acquire. Idempotent. */
  release(): void
}

const NOOP: WakeLockHandle = { release: () => {} }

/**
 * Hold a screen wake lock for as long as the returned handle is unreleased,
 * re-acquiring it after the page returns to the foreground.
 */
export const keepScreenAwake = (): WakeLockHandle => {
  // Feature-detect via `in`: lib.dom types `navigator.wakeLock` as always
  // present, so optional chaining would be a type error while still being the
  // thing that's actually needed at runtime on an old WebView.
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return NOOP

  let sentinel: WakeLockSentinel | null = null
  let done = false

  const acquire = (): void => {
    // Requesting while hidden always rejects; skip it rather than log noise.
    if (done || sentinel || document.visibilityState !== 'visible') return
    try {
      navigator.wakeLock.request('screen').then(
        (s) => {
          if (done) {
            void s.release().catch(() => {})
            return
          }
          sentinel = s
          // Covers the releases we did not ask for (backgrounding, OS policy) so
          // `sentinel` never goes stale and blocks a later re-acquire.
          s.addEventListener('release', () => {
            if (sentinel === s) sentinel = null
          })
        },
        () => {
          // Denied — battery saver, hidden page, no user activation. Play on.
          sentinel = null
        },
      )
    } catch {
      // A non-conforming WebView can throw instead of rejecting. Same answer:
      // the screen may sleep, but the game keeps running.
      sentinel = null
    }
  }

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') acquire()
    // Going hidden ALWAYS costs us the lock. Drop our reference without waiting
    // for the `release` event: if that event were ever missed we would hold a
    // dead sentinel and never re-acquire, which is the exact bug this fixes.
    else sentinel = null
  }

  document.addEventListener('visibilitychange', onVisibility)
  acquire()

  return {
    release() {
      if (done) return
      done = true
      document.removeEventListener('visibilitychange', onVisibility)
      const s = sentinel
      sentinel = null
      if (s) void s.release().catch(() => {})
    },
  }
}
