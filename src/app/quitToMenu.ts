// Main menu: abandon the run and land on the start menu as a fresh boot shows it.
//
// The way back is a navigation to the bare base URL, the same exit Refresh
// takes. Leaving the page is what tears the run down: the sim loop, renderer,
// input readers, audio and every listener go with the JS context, so nothing
// can leak into the next run, and the deep-link params (?world=, ?state=,
// ?scenario=) are dropped so the menu does not boot the same scene again.
//
// Two things must happen before the page goes. The save is cleared and the
// unload flush is switched off, or the abandoned run would be written back and
// resumed. And the net session is closed on purpose, so a host's peers hear
// "the host left" instead of a radio drop. A close that hangs cannot strand the
// player: it gets a bounded grace, then the page leaves anyway.

export interface QuitDeps {
  /** Clear the save and stop the unload flush from writing the run back. */
  abandonRun: () => void
  /** Host: tell the peers and hang up. Client: hang up. Solo: nothing. */
  closeNet: () => Promise<void>
  /** Navigate to the start menu (the base URL, no params). */
  goToMenu: () => void
  wait: (ms: number) => Promise<void>
}

/** How long a net close may take before the page leaves without it. */
export const QUIT_NET_GRACE_MS = 1_500

/** The quit action. It runs once: a second press while leaving does nothing. */
export const createQuitToMenu = (deps: QuitDeps): (() => Promise<void>) => {
  let leaving: Promise<void> | null = null
  const run = async (): Promise<void> => {
    deps.abandonRun()
    await Promise.race([deps.closeNet().catch(() => {}), deps.wait(QUIT_NET_GRACE_MS)])
    deps.goToMenu()
  }
  return () => (leaving ??= run())
}
