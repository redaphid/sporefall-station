/**
 * A tiny gear-button settings panel for the feel knobs: effects quality (for
 * low-end devices) and haptics (phone-only). Self-contained DOM mounted on the
 * game canvas host; persists via settings.ts and reports changes so the live
 * renderer/haptics pick them up without a reload.
 */

import { loadSettings, saveSettings, type EffectsQuality, type GameSettings } from '../app/settings'
import { markUiChrome } from '../ui/chrome'

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
    'position:absolute;right:10px;top:52px;z-index:70;display:none;min-width:200px;padding:12px 14px;' +
    'background:#1a1a22ee;color:#eee;font:13px system-ui;border:1px solid #0008;border-radius:10px;' +
    'box-shadow:0 6px 24px #0008;pointer-events:auto;touch-action:manipulation'

  const qualityRow = `
    <label style="display:block;margin-bottom:10px">Effects
      <select id="q" style="width:100%;margin-top:3px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px">
        <option value="high">High</option>
        <option value="low">Low</option>
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
  const hapticRows = native
    ? `
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="checkbox" id="hen"> Vibration
    </label>
    <label style="display:block">Strength
      <input type="range" id="hin" min="0" max="1" step="0.1" style="width:100%;margin-top:3px">
    </label>`
    : `<div style="opacity:.6">Vibration: phone only</div>`

  panel.innerHTML = qualityRow + themeRow + hapticRows
  mount.appendChild(gear)
  mount.appendChild(panel)

  const q = panel.querySelector<HTMLSelectElement>('#q')!
  q.value = current.effectsQuality
  const th = panel.querySelector<HTMLSelectElement>('#th')
  if (th && themes.some((t) => t.id === current.theme)) th.value = current.theme
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
  })
  q.addEventListener('change', () => apply({ effectsQuality: q.value as EffectsQuality }))
  th?.addEventListener('change', () => apply({ theme: th.value }))
  hen?.addEventListener('change', () => apply({ hapticsEnabled: hen.checked }))
  hin?.addEventListener('input', () => apply({ hapticsIntensity: Number(hin.value) }))

  return { settings: () => current }
}
