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
export const createDebugLog = (mount: HTMLElement): DebugLog => {
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:absolute;top:0;left:0;max-width:min(92vw,460px);max-height:42vh;overflow-y:auto;z-index:90;' +
    'pointer-events:none;padding:6px 8px;background:#000a;color:#8f8;font:11px/1.35 ui-monospace,Menlo,monospace;' +
    'white-space:pre-wrap;word-break:break-word;border-bottom-right-radius:8px'
  mount.appendChild(panel)

  const start = performance.now()
  const lines: string[] = []
  return {
    log(line: string): void {
      const t = ((performance.now() - start) / 1000).toFixed(2).padStart(6, ' ')
      const entry = `${t}s  ${line}`
      lines.push(entry)
      if (lines.length > 200) lines.shift()
      panel.textContent = lines.join('\n')
      panel.scrollTop = panel.scrollHeight
      console.log(`[coop] ${entry}`)
    },
  }
}
