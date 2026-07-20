import { APP_VERSION, otaBundleVersion } from '../app/version'
import { markUiChrome } from './chrome'
import { formatReleaseNotes } from './releaseNotes'

export type GameMode = 'solo' | 'host' | 'join'

/** Solo / Host / Join picker shown at boot. `onPick` fires SYNCHRONOUSLY inside
 * the button's click handler (before resolve) so the caller can run gesture-only
 * browser APIs — e.g. requesting fullscreen — while the user activation is live. */
export const pickMode = (mount: HTMLElement, onPick?: (mode: GameMode) => void): Promise<GameMode> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;pointer-events:auto;color:#eee;font:16px system-ui'
    const options: [GameMode, string, string][] = [
      ['solo', 'Solo run', 'Just you vs the city'],
      ['host', 'Host co-op', 'Others join your game'],
      ['join', 'Join co-op', 'Find a nearby host'],
    ]
    for (const [mode, label, blurb] of options) {
      const b = document.createElement('button')
      b.style.cssText =
        'font:600 17px system-ui;padding:14px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
        'background:#ffffff10;color:#eee;cursor:pointer;width:min(320px,80vw);text-align:left'
      b.innerHTML = `${label} <span style="opacity:.6;font-weight:400;font-size:13px"><br>${blurb}</span>`
      b.addEventListener('click', () => {
        onPick?.(mode) // gesture-live: fullscreen request happens here
        overlay.remove()
        resolve(mode)
      })
      overlay.appendChild(b)
    }
    // Big version readout under the mode picker so you can tell at a glance which
    // build a phone is on (esp. after an OTA update) before starting a game.
    const ver = document.createElement('div')
    ver.style.cssText = 'margin-top:26px;font:800 22px system-ui;letter-spacing:1px;color:#7fd17f'
    ver.textContent = APP_VERSION
    overlay.appendChild(ver)
    void otaBundleVersion().then((b) => {
      if (b && b !== APP_VERSION) ver.textContent = `${APP_VERSION} · ota ${b}`
    })
    // Brief, player-facing "what's new" notes directly under the version number.
    // Small and muted so it reads as supporting text, not a headline. Source of
    // truth + formatting live in releaseNotes.ts (curated per merge to `main`).
    const notes = formatReleaseNotes()
    if (notes.length > 0) {
      const notesBox = document.createElement('div')
      notesBox.style.cssText =
        'margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:2px;' +
        'font:400 12px system-ui;line-height:1.35;color:#ffffff80;text-align:center;max-width:min(320px,80vw)'
      for (const line of notes) {
        const row = document.createElement('div')
        row.textContent = line
        notesBox.appendChild(row)
      }
      overlay.appendChild(notesBox)
    }
    mount.appendChild(overlay)
  })

export type JoinTransportChoice = 'ble' | 'tabs'

/**
 * Desktop-browser join: Bluetooth (phone host) vs same-computer tabs (dev).
 * The Bluetooth button invokes `requestBleDevice` directly inside its click
 * handler because Chrome's requestDevice needs a user gesture; a cancelled
 * chooser keeps the picker open so the player can retry or fall back to tabs.
 */
export const pickJoinTransport = (mount: HTMLElement, requestBleDevice: () => Promise<void>): Promise<JoinTransportChoice> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;pointer-events:auto;color:#eee;font:16px system-ui'
    overlay.innerHTML = `<div style="font:800 22px system-ui">JOIN VIA</div>
      <div id="status" style="opacity:.7;min-height:1.2em"></div>`
    const statusEl = overlay.querySelector<HTMLElement>('#status')!
    const buttons: HTMLButtonElement[] = []
    const addButton = (label: string, blurb: string, onClick: () => void): void => {
      const b = document.createElement('button')
      b.style.cssText =
        'font:600 17px system-ui;padding:14px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
        'background:#ffffff10;color:#eee;cursor:pointer;width:min(320px,80vw);text-align:left'
      b.innerHTML = `${label} <span style="opacity:.6;font-weight:400;font-size:13px"><br>${blurb}</span>`
      b.addEventListener('click', onClick)
      buttons.push(b)
      overlay.appendChild(b)
    }
    addButton('Bluetooth (phone host)', 'Pick a nearby phone hosting a game', () => {
      statusEl.textContent = 'Opening Bluetooth chooser…'
      for (const b of buttons) b.disabled = true
      // Called directly in the click handler: Chrome requires a user gesture.
      requestBleDevice().then(
        () => {
          overlay.remove()
          resolve('ble')
        },
        (err: unknown) => {
          for (const b of buttons) b.disabled = false
          const cancelled = err instanceof Error && err.name === 'NotFoundError'
          statusEl.textContent = cancelled ? 'No device picked — try again' : `Bluetooth error: ${String(err)}`
        },
      )
    })
    addButton('Same-computer tabs (dev)', 'Join a host tab in this browser', () => {
      overlay.remove()
      resolve('tabs')
    })
    mount.appendChild(overlay)
  })

/** BLE join: list hosts as they're discovered; resolves with the chosen deviceId. */
export const pickHost = (
  mount: HTMLElement,
  startScan: (onFound: (h: { deviceId: string; name: string }) => void) => void,
): Promise<string> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;pointer-events:auto;color:#eee;font:16px system-ui'
    overlay.innerHTML = `<div style="font:800 22px system-ui">NEARBY GAMES</div>
      <div style="opacity:.7">Scanning over Bluetooth…</div>
      <div id="hosts" style="display:flex;flex-direction:column;gap:8px;min-width:min(300px,75vw)"></div>`
    const hostsEl = overlay.querySelector<HTMLElement>('#hosts')!
    mount.appendChild(overlay)
    const seen = new Set<string>()
    startScan((h) => {
      if (seen.has(h.deviceId)) return
      seen.add(h.deviceId)
      const b = document.createElement('button')
      b.textContent = h.name
      b.style.cssText =
        'font:600 16px system-ui;padding:12px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
        'background:#ffffff10;color:#eee;cursor:pointer'
      b.addEventListener('click', () => {
        overlay.remove()
        resolve(h.deviceId)
      })
      hostsEl.appendChild(b)
    })
  })

export interface LobbyUi {
  setPlayers(players: { slot: number; name: string }[]): void
  setStatus(text: string): void
  /** Resolves when the host presses Start (host mode only). */
  waitForStart(): Promise<void>
  close(): void
}

export const createLobbyUi = (mount: HTMLElement, isHost: boolean): LobbyUi => {
  const overlay = document.createElement('div')
  markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
  overlay.style.cssText =
    'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:12px;pointer-events:auto;color:#eee;font:16px system-ui'
  overlay.innerHTML = `
    <div style="font:800 22px system-ui">${isHost ? 'HOSTING' : 'LOBBY'}</div>
    <div id="status" style="opacity:.7"></div>
    <div id="players" style="display:flex;flex-direction:column;gap:6px;min-width:min(300px,75vw)"></div>
  `
  const playersEl = overlay.querySelector<HTMLElement>('#players')!
  const statusEl = overlay.querySelector<HTMLElement>('#status')!

  let startResolve: (() => void) | null = null
  if (isHost) {
    const startBtn = document.createElement('button')
    startBtn.textContent = 'Start game'
    startBtn.style.cssText =
      'font:700 17px system-ui;padding:12px 30px;border-radius:10px;border:0;background:#7fd17f;' +
      'color:#0b0b12;cursor:pointer;margin-top:8px'
    startBtn.addEventListener('click', () => startResolve?.())
    overlay.appendChild(startBtn)
  }

  // Build/OTA version readout, so you can tell at a glance which build a phone is
  // running (esp. after an over-the-air update). Shows the baked-in code version
  // immediately, then appends the live OTA bundle id once the plugin answers.
  const ver = document.createElement('div')
  ver.style.cssText =
    'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);opacity:.5;font:600 12px system-ui;pointer-events:none'
  ver.textContent = `build ${APP_VERSION}`
  overlay.appendChild(ver)
  void otaBundleVersion().then((b) => {
    if (b) ver.textContent = `build ${APP_VERSION} · ota ${b}`
  })

  mount.appendChild(overlay)

  return {
    setPlayers(players): void {
      playersEl.innerHTML = players
        .map(
          (p) =>
            `<div style="background:#ffffff12;border-radius:8px;padding:8px 12px">` +
            `P${p.slot + 1} · ${p.name}</div>`,
        )
        .join('')
    },
    setStatus(text): void {
      statusEl.textContent = text
    },
    waitForStart: () => new Promise((r) => (startResolve = r)),
    close: () => overlay.remove(),
  }
}
