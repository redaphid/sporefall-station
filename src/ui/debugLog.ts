export interface DebugLog {
  /** Append a timestamped line to the on-screen panel (and console). */
  log(line: string): void
}

/**
 * On-device diagnostics panel for the co-op host/join flows. A real two-phone
 * BLE session can't be watched over a single adb cable, so we surface the
 * advertise → scan → connect → handshake steps directly on screen. Top-left,
 * click-through, capped scrollback.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createDebugLog = (_mount: HTMLElement): DebugLog => {
  // On-screen panel disabled — diagnostics go to the console only (readable via
  // `adb logcat`). Call sites keep passing dbg.log into the BLE transports.
  const start = performance.now()
  return {
    log(line: string): void {
      const t = ((performance.now() - start) / 1000).toFixed(2).padStart(6, ' ')
      console.log(`[coop] ${t}s  ${line}`)
    },
  }
}
