/**
 * A tiny gear-button settings panel for the feel knobs: effects quality (for
 * low-end devices), haptics (phone-only), theme, and controller button
 * remapping. Self-contained DOM mounted on the game canvas host; persists via
 * settings.ts / remap.ts and reports changes so the live renderer/haptics/
 * gamepad reader pick them up without a reload.
 *
 * The Controller section: one row per remappable action showing its current
 * binding by canonical name (A/B/…/Start, 'Button N' for exotic indices). Tap
 * a binding → capture mode ("press a button…"): the next NEW button press on
 * any connected pad binds (axes never bind — see padCapture.ts), Esc or a tap
 * anywhere else cancels, and it times out after ~8s. While capturing, the
 * remap layer's capture flag keeps the press out of gameplay entirely.
 * Binding a button another action owns SWAPS the two (stated in the UI copy).
 */

import { FEATURE_FLAGS } from '../app/featureFlags'
import { loadSettings, saveSettings, type EffectsQuality, type GameSettings, type ShaderFxMode } from '../app/settings'
import { createButtonCapture, type ButtonCapture } from '../input/padCapture'
import { buttonPressed } from '../input/readPad'
import {
  ACTION_LABELS,
  bindButton,
  bindingLabel,
  defaultButtonMap,
  getButtonMap,
  PAD_ACTIONS,
  resetAction,
  setButtonMap,
  setPadCapture,
  type PadAction,
} from '../input/remap'
import { markUiChrome } from '../ui/chrome'
import { enterFullscreen, exitFullscreen } from '../ui/fullscreenModel'

export interface SettingsPanel {
  settings(): GameSettings
}

export interface ThemeOption {
  id: string
  name: string
}

export const createSettingsPanel = (
  mount: HTMLElement,
  native: boolean,
  onChange: (s: GameSettings) => void,
  themes: ThemeOption[] = [],
  // Injectable for tests; the default is the same live surface gamepadCoop polls.
  getPads: () => readonly (Gamepad | null)[] = () => navigator.getGamepads?.() ?? [],
): SettingsPanel => {
  let current = loadSettings()

  // The gear + panel are UI CHROME (chrome.ts): they must mount on the UI
  // layer ABOVE the touch controls' full-screen stick zones (renderer.ts passes
  // #ui) and are marked data-ui-chrome so a tap on them never enters the
  // stick/inspect press classification. Mounted on the canvas host instead,
  // touches would be swallowed by the zones and the gear would be mouse-only.
  const gear = document.createElement('button')
  gear.textContent = '⚙'
  gear.setAttribute('aria-label', 'Settings')
  markUiChrome(gear)
  gear.style.cssText =
    'position:absolute;right:10px;top:10px;z-index:70;width:34px;height:34px;border-radius:8px;' +
    'border:1px solid #0008;background:#222c;color:#eee;font-size:18px;cursor:pointer;pointer-events:auto;' +
    'touch-action:manipulation'

  const panel = document.createElement('div')
  markUiChrome(panel)
  panel.style.cssText =
    'position:absolute;right:10px;top:52px;z-index:70;display:none;min-width:236px;max-width:300px;' +
    'max-height:calc(100% - 64px);overflow-y:auto;padding:12px 14px;' +
    'background:#1a1a22ee;color:#eee;font:13px system-ui;border:1px solid #0008;border-radius:10px;' +
    'box-shadow:0 6px 24px #0008;pointer-events:auto;touch-action:manipulation'

  const qualityRow = `
    <label style="display:block;margin-bottom:10px">Effects
      <select id="q" style="width:100%;margin-top:3px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px">
        <option value="high">High</option>
        <option value="low">Low</option>
        <option value="off">Off</option>
      </select>
    </label>
    <label style="display:block;margin-bottom:10px">Shader FX
      <select id="fx" style="width:100%;margin-top:3px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px">
        <option value="full">Full</option>
        <option value="reduced">Reduced</option>
        <option value="off">Off</option>
      </select>
    </label>`
  // Theme picker only when more than one theme is installed. Selection is
  // presentation-only (persisted locally; never crosses the wire).
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const themeRow =
    themes.length > 1
      ? `
    <label style="display:block;margin-bottom:10px">Theme
      <select id="th" style="width:100%;margin-top:3px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px">
        ${themes.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
      </select>
    </label>`
      : ''
  // Fullscreen toggle — desktop/web only. The native Capacitor shell is already
  // fullscreen, so the row is hidden there (nothing to toggle). Toggling here is
  // itself a user gesture, so the Fullscreen API request is honoured directly.
  // FEATURE FLAGS — rendered from the registry (app/featureFlags.ts), never
  // hand-maintained here. New work ships dark behind a flag routinely now, so
  // adding one must not require touching this file, and every flag must appear
  // in ONE findable place with a plain-English label and a line saying what it
  // actually changes. A flag he cannot find may as well not exist.
  const flagRows = FEATURE_FLAGS.length
    ? `<div style="margin-bottom:10px">
      <div style="opacity:.7;margin-bottom:4px">Try new things</div>
      ${FEATURE_FLAGS.map(
        (f) => `
      <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
        <input type="checkbox" data-flag="${esc(f.key)}" style="margin-top:3px">
        <span>${esc(f.label)}<br><span style="opacity:.6;font-size:.85em">${esc(f.description)}</span></span>
      </label>`,
      ).join('')}
    </div>`
    : ''
  const fullscreenRow = native
    ? ''
    : `
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <input type="checkbox" id="fs"> Fullscreen
    </label>`
  const hapticRows = native
    ? `
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="checkbox" id="hen"> Vibration
    </label>
    <label style="display:block">Strength
      <input type="range" id="hin" min="0" max="1" step="0.1" style="width:100%;margin-top:3px">
    </label>`
    : `<div style="opacity:.6">Vibration: phone only</div>`

  panel.innerHTML = qualityRow + themeRow + flagRows + fullscreenRow + hapticRows

  // ---- Controller section: button remapping (remap.ts overlay) ------------
  let map = getButtonMap()
  const ctl = document.createElement('div')
  ctl.id = 'ctl'
  ctl.style.cssText = 'margin-top:12px;border-top:1px solid #ffffff22;padding-top:10px'
  const ctlHead = document.createElement('div')
  ctlHead.textContent = 'Controller'
  ctlHead.style.cssText = 'font-weight:600;margin-bottom:6px'
  ctl.appendChild(ctlHead)

  const bindBtns = new Map<PadAction, HTMLButtonElement>()
  interface Capture {
    action: PadAction
    machine: ButtonCapture
    timer: ReturnType<typeof setInterval>
    /** Once bound: the captured button, drained until RELEASED. The press that
     * binds must be spent entirely — without this, binding a held-to-fire
     * action (attack) makes the still-held finger start shooting the instant
     * the bind lands. Capped so a stuck button can't disable pads forever. */
    drain?: { button: number; until: number }
  }
  let capture: Capture | null = null

  const renderRows = (): void => {
    for (const [action, btn] of bindBtns) {
      if (capture?.action === action && !capture.drain) continue // capture text is managed by captureTick
      btn.textContent = bindingLabel(map[action])
      btn.style.color = '#eee'
    }
  }

  const stopCapture = (): void => {
    if (!capture) return
    clearInterval(capture.timer)
    capture = null
    setPadCapture(false) // gameplay sees pads again from the next sample
    renderRows()
  }

  const captureTick = (): void => {
    if (!capture) return
    if (capture.drain) {
      const held = getPads().some((p) => p !== null && buttonPressed(p, capture!.drain!.button))
      if (!held || Date.now() >= capture.drain.until) stopCapture()
      return
    }
    const st = capture.machine.poll(getPads(), Date.now())
    const btn = bindBtns.get(capture.action)!
    if (st.phase === 'bound') {
      map = bindButton(map, capture.action, st.button)
      setButtonMap(map) // persists + applies on the next gamepad poll
      capture.drain = { button: st.button, until: Date.now() + 3000 }
      renderRows() // show the new binding immediately; inertness holds until release
    } else if (st.phase === 'timed-out') {
      stopCapture()
    } else {
      // Chrome exposes a pad only after a button press — tell the player that.
      btn.textContent = st.phase === 'no-pads' ? 'no controller detected — press any button on it' : 'press a button…'
      btn.style.color = '#8cf'
    }
  }

  const startCapture = (action: PadAction): void => {
    const again = capture?.action === action
    stopCapture()
    if (again) return // tapping the already-capturing row cancels it
    setPadCapture(true) // the captured press must be inert in gameplay
    capture = { action, machine: createButtonCapture(), timer: setInterval(captureTick, 50) }
    captureTick()
  }

  const rowBtnStyle =
    'background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:3px 7px;cursor:pointer;' +
    'font:12px system-ui;text-align:left;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'touch-action:manipulation'

  for (const action of PAD_ACTIONS) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px'
    const label = document.createElement('span')
    label.textContent = ACTION_LABELS[action]
    label.style.cssText = 'width:88px;flex:none'
    const bind = document.createElement('button')
    bind.dataset.remapAction = action
    bind.style.cssText = rowBtnStyle
    bind.addEventListener('click', () => startCapture(action))
    const reset = document.createElement('button')
    reset.dataset.remapReset = action
    reset.textContent = '↺'
    reset.setAttribute('aria-label', `Reset ${ACTION_LABELS[action]} binding`)
    reset.style.cssText =
      'background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:3px 6px;cursor:pointer;' +
      'font:12px system-ui;flex:none;touch-action:manipulation'
    reset.addEventListener('click', () => {
      stopCapture()
      map = resetAction(map, action)
      setButtonMap(map)
      renderRows()
    })
    bindBtns.set(action, bind)
    row.append(label, bind, reset)
    ctl.appendChild(row)
  }

  const resetAll = document.createElement('button')
  resetAll.id = 'ctl-reset'
  resetAll.textContent = 'Reset to defaults'
  resetAll.style.cssText =
    'width:100%;margin-top:4px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px;' +
    'cursor:pointer;font:12px system-ui;touch-action:manipulation'
  resetAll.addEventListener('click', () => {
    stopCapture()
    map = defaultButtonMap()
    setButtonMap(map)
    renderRows()
  })
  ctl.appendChild(resetAll)

  const hint = document.createElement('div')
  hint.textContent =
    'Tap a binding, then press the button on your controller. A button that is already in use swaps with that action.'
  hint.style.cssText = 'opacity:.55;margin-top:6px;font-size:11px;line-height:1.35'
  ctl.appendChild(hint)

  renderRows()
  panel.appendChild(ctl)

  // Cancel paths beyond timeout: Esc, and a tap/click anywhere that is not the
  // capturing row. The listeners live as long as the panel does (it is never
  // torn down in the app), but they guard on isConnected so a REPLACED panel
  // can never reach through the global capture flag and strand a live one.
  // The click that STARTS a capture bubbles here with the row itself as
  // target, so it never self-cancels.
  document.addEventListener('keydown', (e) => {
    if (panel.isConnected && e.key === 'Escape') stopCapture()
  })
  document.addEventListener('click', (e) => {
    if (!capture || !panel.isConnected) return
    const t = e.target as Element | null
    if (t?.closest('[data-remap-action]') !== bindBtns.get(capture.action)) stopCapture()
  })

  mount.appendChild(gear)
  mount.appendChild(panel)

  const q = panel.querySelector<HTMLSelectElement>('#q')!
  q.value = current.effectsQuality
  const fx = panel.querySelector<HTMLSelectElement>('#fx')!
  fx.value = current.shaderFx
  const th = panel.querySelector<HTMLSelectElement>('#th')
  if (th && themes.some((t) => t.id === current.theme)) th.value = current.theme
  const fs = panel.querySelector<HTMLInputElement>('#fs') // null on native
  if (fs) fs.checked = current.fullscreen
  // Wire every registered flag generically: initial state from settings, and a
  // change handler that writes back through the same clamped save path.
  for (const box of panel.querySelectorAll<HTMLInputElement>('input[data-flag]')) {
    const key = box.dataset.flag!
    box.checked = current.flags?.[key] === true
    box.addEventListener('change', () => apply({ flags: { ...current.flags, [key]: box.checked } }))
  }
  const hen = panel.querySelector<HTMLInputElement>('#hen')
  const hin = panel.querySelector<HTMLInputElement>('#hin')
  if (hen) hen.checked = current.hapticsEnabled
  if (hin) hin.value = String(current.hapticsIntensity)

  const apply = (next: Partial<GameSettings>): void => {
    current = { ...current, ...next }
    saveSettings(current)
    onChange(current)
  }

  gear.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
    if (panel.style.display === 'none') stopCapture() // closing the panel always ends capture
  })
  q.addEventListener('change', () => apply({ effectsQuality: q.value as EffectsQuality }))
  fx.addEventListener('change', () => apply({ shaderFx: fx.value as ShaderFxMode }))
  th?.addEventListener('change', () => apply({ theme: th.value }))
  // The checkbox change IS the user gesture, so enter/exit fullscreen directly
  // here (feature-detected + rejection-swallowing inside the glue). Persist the
  // choice so run-start honours it next time.
  fs?.addEventListener('change', () => {
    if (fs.checked) enterFullscreen(document.documentElement)
    else exitFullscreen()
    apply({ fullscreen: fs.checked })
  })
  hen?.addEventListener('change', () => apply({ hapticsEnabled: hen.checked }))
  hin?.addEventListener('input', () => apply({ hapticsIntensity: Number(hin.value) }))

  return { settings: () => current }
}
