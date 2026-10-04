// The floor-modifier strip under the mission chip: pure text for the DOM layer
// (screens.ts). A small line at the top edge, never a banner over the player.

import type { FloorModifierKind, ModifierView } from '../game/floorModifiers'
import type { SimEvent } from '../game/types'

export const MODIFIER_INFO: Record<FloorModifierKind, { icon: string; name: string; blurb: string }> = {
  bogTide: { icon: '🌊', name: 'BOG TIDE', blurb: 'low ground floods on a cycle' },
  brownout: { icon: '🔦', name: 'BROWNOUT', blurb: 'the lights are failing' },
  hunted: { icon: '🐺', name: 'HUNTED', blurb: 'a tracker pack will follow your scent' },
}

/** How long the full description shows after a modifier appears. */
export const ANNOUNCE_MS = 6000

/** Changes whenever a new modifier takes hold (a new floor, or a new run). */
export const modifierKey = (floor: number, m: ModifierView | undefined): string => (m ? `${floor}:${m.kind}` : '')

/** The strip's text: the full description while announcing, then a compact
 * live readout. Empty on a clean floor. */
export const modifierStripText = (m: ModifierView | undefined, announcing: boolean): string => {
  if (!m) return ''
  const info = MODIFIER_INFO[m.kind]
  const head = `${info.icon} ${info.name}`
  if (announcing) return `${head} — ${info.blurb}`
  if (m.kind === 'bogTide') return m.flooded ? `${head} · TIDE IN — wading is slow` : head
  if (m.kind === 'hunted') return m.huntIn !== undefined ? `${head} · pack in ${m.huntIn}s` : `${head} · they have your scent`
  return head
}

/** One-line toast for a modifier beat this tick, if any. */
export const modifierToast = (ev: SimEvent): string | undefined => {
  if (ev.type === 'tide' && ev.rising) return '🌊 The tide is coming in'
  if (ev.type === 'huntersArrive') return '🐺 Hunters picked up your trail'
  return undefined
}
