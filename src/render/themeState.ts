/**
 * The active theme chain, held module-level so presentation code far from the
 * renderer (the tap-inspect card, HUD strings) can resolve themed display
 * names without threading the chain through every constructor. Render/UI-side
 * only — the sim never reads this.
 */

import { themedName, type ThemeChain } from './theme'

let active: ThemeChain = []

export const setActiveThemeChain = (chain: ThemeChain): void => {
  active = chain
}

/** Themed display name for an archetype (falls back to title-casing the key).
 * Resolved lazily on every call, so a runtime theme swap re-labels the next
 * card opened with no re-wiring. */
export const themeDisplayName = (archetype: string): string => themedName(archetype, active)
