/**
 * A tiny gear-button settings panel for the feel knobs: effects quality (for
 * low-end devices) and haptics (phone-only). Self-contained DOM mounted on the
 * game canvas host; persists via settings.ts and reports changes so the live
 * renderer/haptics pick them up without a reload.
 */

import { loadSettings, saveSettings, type EffectsQuality, type GameSettings } from '../app/settings'

export interface SettingsPanel {
  settings(): GameSettings
}

export const createSettingsPanel = (
  mount: HTMLElement,
  native: boolean,
  onChange: (s: GameSettings) => void,
): SettingsPanel => {
  let current = loadSettings()

  const gear = document.createElement('button')
  gear.textContent = '⚙'
  gear.setAttribute('aria-label', 'Settings')
  gear.style.cssText =
    'position:absolute;right:10px;top:10px;z-index:70;width:34px;height:34px;border-radius:8px;' +
    'border:1px solid #0008;background:#222c;color:#eee;font-size:18px;cursor:pointer;pointer-events:auto'

  const panel = document.createElement('div')
  panel.style.cssText =
    'position:absolute;right:10px;top:52px;z-index:70;display:none;min-width:200px;padding:12px 14px;' +
    'background:#1a1a22ee;color:#eee;font:13px system-ui;border:1px solid #0008;border-radius:10px;' +
    'box-shadow:0 6px 24px #0008;pointer-events:auto'

  const qualityRow = `
    <label style="display:block;margin-bottom:10px">Effects
      <select id="q" style="width:100%;margin-top:3px;background:#111;color:#eee;border:1px solid #0006;border-radius:5px;padding:4px">
        <option value="high">High</option>
        <option value="low">Low</option>
        <option value="off">Off</option>
      </select>
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

  panel.innerHTML = qualityRow + hapticRows
  mount.appendChild(gear)
  mount.appendChild(panel)

  const q = panel.querySelector<HTMLSelectElement>('#q')!
  q.value = current.effectsQuality
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
  hen?.addEventListener('change', () => apply({ hapticsEnabled: hen.checked }))
  hin?.addEventListener('input', () => apply({ hapticsIntensity: Number(hin.value) }))

  return { settings: () => current }
}
