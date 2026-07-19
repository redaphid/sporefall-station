/**
 * Player-tweakable feel settings: haptics (phone-only) and visual-effects
 * quality. Persisted to localStorage so a choice survives a reload. The
 * clamp/parse helpers are pure so they can be unit-tested without a DOM.
 */

export type EffectsQuality = 'off' | 'low' | 'high'

export interface GameSettings {
  /** Master switch for vibration. Phone-only; a no-op on web/desktop anyway. */
  hapticsEnabled: boolean
  /** 0..1 scale on vibration strength. */
  hapticsIntensity: number
  /** Visual juice budget: 'off' for low-end devices, 'high' for GPU filters. */
  effectsQuality: EffectsQuality
  /** Active visual theme id (public/themes/<id>/). Pure presentation — never
   * touches the sim; peers in a net game may each use a different theme. */
  theme: string
}

const STORAGE_KEY = 'sor.settings'

export const defaultSettings = (): GameSettings => ({
  hapticsEnabled: true,
  hapticsIntensity: 0.7,
  effectsQuality: 'high',
  theme: 'city',
})

const QUALITIES: readonly EffectsQuality[] = ['off', 'low', 'high']

/** Mirrors theme.ts isValidThemeId without importing the render layer. */
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]*$/

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Coerce arbitrary/partial input into a valid settings object, filling gaps
 * from defaults and clamping out-of-range values. Pure — safe to test. */
export const clampSettings = (raw: unknown): GameSettings => {
  const base = defaultSettings()
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  return {
    hapticsEnabled: typeof r.hapticsEnabled === 'boolean' ? r.hapticsEnabled : base.hapticsEnabled,
    hapticsIntensity:
      typeof r.hapticsIntensity === 'number' && Number.isFinite(r.hapticsIntensity)
        ? clamp01(r.hapticsIntensity)
        : base.hapticsIntensity,
    effectsQuality: QUALITIES.includes(r.effectsQuality as EffectsQuality)
      ? (r.effectsQuality as EffectsQuality)
      : base.effectsQuality,
    theme:
      typeof r.theme === 'string' && r.theme.length <= 64 && THEME_ID_RE.test(r.theme)
        ? r.theme
        : base.theme,
  }
}

export const loadSettings = (): GameSettings => {
  try {
    if (typeof localStorage === 'undefined') return defaultSettings()
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultSettings()
    return clampSettings(JSON.parse(raw))
  } catch {
    return defaultSettings()
  }
}

export const saveSettings = (s: GameSettings): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clampSettings(s)))
  } catch {
    // Private-mode / quota failures are non-fatal; settings just won't persist.
  }
}
