import { APP_VERSION, otaBundleVersion } from '../app/version'
import { markUiChrome } from './chrome'
import { formatReleaseNotes } from './releaseNotes'
import { installGamepadMenuNav } from './gamepadMenu'

export type GameMode = 'solo' | 'host' | 'join'

/** The settings panel, as the start menu drives it (renderer.settingsUi):
 * `open` shows it with controller navigation armed; `isOpen` lets the menu's
 * own navigator stand down while the panel owns the pad. */
export interface SettingsControl {
  open(): void
  close(): void
  isOpen(): boolean
}

/**
 * Start-menu layout. A stylesheet rather than inline styles because it needs
 * container queries, which inline styles cannot express.
 *
 * WHY CONTAINER QUERIES, NOT MEDIA QUERIES: on a phone held in portrait the
 * whole stage is rotated to landscape (orientation.ts), so a 360x640 viewport
 * lays this menu out in a 640x360 box. A media query would read the VIEWPORT
 * (tall) and pick the tall layout for a short box. The overlay is the size
 * container, so `cqh`/`@container` always see the box the player actually sees.
 *
 * The old menu was a fixed ~450px centred column; in a ~360px landscape box it
 * overflowed at BOTH ends, and a centred flex overflow at the top can never be
 * scrolled back, so "Solo run" was simply gone. Now:
 *   • sizes scale with box height (clamp + cqh), buttons never under 48px;
 *   • a short, wide box puts the buttons in a 2x2 grid;
 *   • padding respects the stage-space safe-area insets (--sf-safe-*,
 *     orientation.ts), so a notch on either physical edge is honoured;
 *   • if it STILL doesn't fit (tiny box, huge font setting) the overlay scrolls,
 *     and the centring is done with `margin:auto` on a min-height:100% child so
 *     overflow always extends downwards, never off the unreachable top.
 * Covered by e2e/start-menu-fit.mjs across phone viewports + desktop.
 */
const START_MENU_CSS = `
.sf-start{position:absolute;inset:0;container-type:size;overflow-x:hidden;overflow-y:auto;
  overscroll-behavior:contain;touch-action:pan-y;pointer-events:auto;background:#0b0b12;color:#eee;font:16px system-ui}
.sf-start__inner{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:clamp(4px,1.6cqh,8px);
  padding:max(clamp(8px,3cqh,20px),var(--sf-safe-top,0px)) max(16px,var(--sf-safe-right,0px))
    max(clamp(8px,3cqh,20px),var(--sf-safe-bottom,0px)) max(16px,var(--sf-safe-left,0px))}
.sf-start__buttons{display:grid;grid-template-columns:minmax(0,1fr);gap:clamp(6px,2cqh,10px);width:min(320px,100%)}
.sf-start__btn{box-sizing:border-box;width:100%;min-height:48px;margin:0;text-align:left;cursor:pointer;
  font:600 clamp(15px,4.4cqh,17px)/1.2 system-ui;padding:clamp(7px,2.6cqh,14px) clamp(12px,3cqw,18px);
  border-radius:10px;border:2px solid #ffffff2e;background:#ffffff10;color:#eee;touch-action:manipulation}
.sf-start__blurb{display:block;opacity:.6;font-weight:400;font-size:clamp(11px,3.4cqh,13px)}
.sf-start__ver{margin-top:clamp(4px,4.5cqh,26px);font:800 clamp(16px,5.5cqh,22px) system-ui;letter-spacing:1px;
  color:#7fd17f;text-align:center;overflow-wrap:anywhere}
.sf-start__notes{display:flex;flex-direction:column;align-items:center;gap:2px;max-width:min(320px,100%);
  font:400 clamp(11px,3.2cqh,12px)/1.35 system-ui;color:#ffffff80;text-align:center}
@container (max-height:560px) and (min-width:480px){
  .sf-start__buttons{grid-template-columns:repeat(2,minmax(0,1fr));width:min(520px,100%)}
  .sf-start__notes{max-width:min(520px,100%)}
}
`

const START_MENU_STYLE_ID = 'sf-start-menu-style'

const installStartMenuStyle = (): void => {
  if (document.getElementById(START_MENU_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = START_MENU_STYLE_ID
  style.textContent = START_MENU_CSS
  document.head.appendChild(style)
}

/** Solo / Host / Join picker shown at boot. `onPick` fires SYNCHRONOUSLY inside
 * the button's click handler (before resolve) so the caller can run gesture-only
 * browser APIs — e.g. requesting fullscreen — while the user activation is live.
 * `settings` adds a fourth entry that opens the settings panel OVER the menu
 * (never resolving the promise) — the controller-only player's route to button
 * remapping; while the panel is open, the menu's pad navigation is suppressed
 * so exactly one navigator reacts. */
export const pickMode = (
  mount: HTMLElement,
  onPick?: (mode: GameMode) => void,
  settings?: SettingsControl,
): Promise<GameMode> =>
  new Promise((resolve) => {
    installStartMenuStyle()
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.className = 'sf-start'
    overlay.dataset.role = 'start-menu'
    const inner = document.createElement('div')
    inner.className = 'sf-start__inner'
    const buttonsBox = document.createElement('div')
    buttonsBox.className = 'sf-start__buttons'
    inner.appendChild(buttonsBox)
    overlay.appendChild(inner)
    const options: [GameMode, string, string][] = [
      ['solo', 'Solo run', 'Just you vs the spores'],
      ['host', 'Host co-op', 'Others join your game'],
      ['join', 'Join co-op', 'Find a nearby host'],
    ]
    const navButtons: HTMLButtonElement[] = []
    let stopNav: () => void = () => {}
    const menuButton = (html: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'sf-start__btn'
      b.innerHTML = html
      navButtons.push(b)
      buttonsBox.appendChild(b)
      return b
    }
    const blurbed = (label: string, blurb: string): string =>
      `${label} <span class="sf-start__blurb">${blurb}</span>`
    for (const [mode, label, blurb] of options) {
      menuButton(blurbed(label, blurb)).addEventListener('click', () => {
        stopNav()
        settings?.close() // never carry the panel (and its navigator) into the lobby
        onPick?.(mode) // gesture-live: fullscreen request happens here
        overlay.remove()
        resolve(mode)
      })
    }
    if (settings) {
      // Opens the panel over the menu; deliberately does NOT resolve the mode
      // promise — closing the panel lands the player back on this menu.
      const b = menuButton(blurbed('Settings', 'Controls, theme, effects'))
      b.dataset.role = 'menu-settings'
      b.addEventListener('click', () => settings.open())
    }
    // Controller support: a gamepad-only player can move focus + confirm here.
    // Suppressed while the settings panel is open — the panel runs its own
    // navigator, and two live navigators would both react to every press.
    stopNav = installGamepadMenuNav(() => navButtons, { suppress: () => settings?.isOpen() ?? false })
    // Big version readout under the mode picker so you can tell at a glance which
    // build a phone is on (esp. after an OTA update) before starting a game.
    const ver = document.createElement('div')
    ver.className = 'sf-start__ver'
    ver.textContent = APP_VERSION
    inner.appendChild(ver)
    void otaBundleVersion().then((b) => {
      if (b && b !== APP_VERSION) ver.textContent = `${APP_VERSION} · ota ${b}`
    })
    // Brief, player-facing "what's new" notes directly under the version number.
    // Small and muted so it reads as supporting text, not a headline. Source of
    // truth + formatting live in releaseNotes.ts (curated per merge to `main`).
    const notes = formatReleaseNotes()
    if (notes.length > 0) {
      const notesBox = document.createElement('div')
      notesBox.className = 'sf-start__notes'
      for (const line of notes) {
        const row = document.createElement('div')
        row.textContent = line
        notesBox.appendChild(row)
      }
      inner.appendChild(notesBox)
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
    let stopNav: () => void = () => {}
    addButton('Bluetooth (phone host)', 'Pick a nearby phone hosting a game', () => {
      statusEl.textContent = 'Opening Bluetooth chooser…'
      for (const b of buttons) b.disabled = true
      // Called directly in the click handler: Chrome requires a user gesture.
      requestBleDevice().then(
        () => {
          stopNav()
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
      stopNav()
      overlay.remove()
      resolve('tabs')
    })
    stopNav = installGamepadMenuNav(() => buttons)
    mount.appendChild(overlay)
  })

/** BLE join: list hosts as they're discovered; resolves with the chosen deviceId. */
export const pickHost = (
  mount: HTMLElement,
  startScan: (onFound: (h: { deviceId: string; name: string }) => void, onError: (message: string) => void) => void,
): Promise<string> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;pointer-events:auto;color:#eee;font:16px system-ui'
    overlay.innerHTML = `<div style="font:800 22px system-ui">NEARBY GAMES</div>
      <div id="scan-status" style="opacity:.7;max-width:min(320px,80vw);text-align:center">Scanning over Bluetooth…</div>
      <div id="hosts" style="display:flex;flex-direction:column;gap:8px;min-width:min(300px,75vw)"></div>`
    const hostsEl = overlay.querySelector<HTMLElement>('#hosts')!
    const statusEl = overlay.querySelector<HTMLElement>('#scan-status')!
    mount.appendChild(overlay)
    const seen = new Set<string>()
    const stopNav = installGamepadMenuNav(() => Array.from(hostsEl.querySelectorAll('button')))
    startScan(
      (h) => {
        if (seen.has(h.deviceId)) return
        seen.add(h.deviceId)
        const b = document.createElement('button')
        b.textContent = h.name
        b.style.cssText =
          'font:600 16px system-ui;padding:12px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
          'background:#ffffff10;color:#eee;cursor:pointer'
        b.addEventListener('click', () => {
          stopNav()
          overlay.remove()
          resolve(h.deviceId)
        })
        hostsEl.appendChild(b)
      },
      // A scan that rejects used to go nowhere, so this overlay said "Scanning
      // over Bluetooth…" until the phone was force-quit — which to anyone watching
      // looks like the GAME is broken, not a setting. This is the only screen up
      // at that moment (the lobby is behind it), so the bad news goes here.
      //
      // Reload is the honest way back: this promise can no longer resolve, and a
      // reload re-runs the permission request and the BLE init from scratch and
      // lands on the start menu.
      (message) => {
        statusEl.textContent = message
        statusEl.style.opacity = '1'
        if (hostsEl.querySelector('#scan-back')) return
        const back = document.createElement('button')
        back.id = 'scan-back'
        back.textContent = 'Back to menu'
        back.style.cssText =
          'font:600 16px system-ui;padding:12px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
          'background:#ffffff10;color:#eee;cursor:pointer'
        back.addEventListener('click', () => location.reload())
        hostsEl.appendChild(back)
      },
    )
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
  let stopNav: () => void = () => {}
  if (isHost) {
    const startBtn = document.createElement('button')
    startBtn.textContent = 'Start game'
    startBtn.style.cssText =
      'font:700 17px system-ui;padding:12px 30px;border-radius:10px;border:0;background:#7fd17f;' +
      'color:#0b0b12;cursor:pointer;margin-top:8px'
    startBtn.addEventListener('click', () => startResolve?.())
    overlay.appendChild(startBtn)
    // Host can start the co-op run from a controller.
    stopNav = installGamepadMenuNav(() => [startBtn])
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
    close: () => {
      stopNav()
      overlay.remove()
    },
  }
}
