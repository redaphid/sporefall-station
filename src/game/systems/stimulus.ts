// #66 — the shared STIMULUS field. A hive (the Infected, spore-vermin) reads the
// station as a set of stimuli — the loudest noise, the brightest spore bloom, a
// gunshot, a fire — and is DRAWN to the strongest one, so a swarm reads as a
// purposeful tide with a shared focus the players can bait and misdirect.
//
// Stimuli are DERIVED from live world state each query (heard noises + fire +
// spore cells), not a stored list — so nothing new to serialize and it can never
// drift from the world. Ascending, fixed order (noises in list order, then
// entities in id order) → argmax is fully deterministic. Also the wake trigger
// source for dormancy (#68).

import type { World } from '../world'
import { vlen } from '../simMath'

export type StimulusKind = 'noise' | 'fire' | 'spore'

export interface Stimulus {
  kind: StimulusKind
  x: number
  y: number
  intensity: number
}

/** Base intensities — the pecking order a hive weighs (fire brightest, then a
 * bloom, then a plain noise). Spore scales a little with its cell's fuel. */
export const NOISE_INTENSITY = 4
export const FIRE_INTENSITY = 7
export const SPORE_INTENSITY = 3

/** Distance falloff for the draw: bigger = "closer" matters more vs "louder".
 * Tuned so a clearly louder stimulus a bit farther still wins the swarm. */
const DRAW_FALLOFF = 0.12

/** Every current draw stimulus, derived from the live world. */
export const gatherStimuli = (w: World): Stimulus[] => {
  const out: Stimulus[] = []
  for (const n of w.noises) out.push({ kind: 'noise', x: n.x, y: n.y, intensity: NOISE_INTENSITY })
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.fire) out.push({ kind: 'fire', x: e.pos.x, y: e.pos.y, intensity: FIRE_INTENSITY })
    else if (e.spore) out.push({ kind: 'spore', x: e.pos.x, y: e.pos.y, intensity: SPORE_INTENSITY + e.spore.fuel / 80 })
  }
  return out
}

/** Distance-attenuated pull of a stimulus at (x,y): louder/brighter beats
 * closer, but a distant whisper loses. */
export const stimulusPull = (s: Stimulus, x: number, y: number): number =>
  s.intensity / (1 + vlen(s.x - x, s.y - y) * DRAW_FALLOFF)

/** The strongest stimulus within `range` of (x,y) — the point a hive member with
 * no direct target drifts toward. Ties break to the first in gather order. */
export const strongestStimulus = (w: World, x: number, y: number, range: number): Stimulus | undefined => {
  let best: Stimulus | undefined
  let bestPull = 0
  for (const s of gatherStimuli(w)) {
    if (vlen(s.x - x, s.y - y) > range) continue
    const pull = stimulusPull(s, x, y)
    if (pull > bestPull) {
      bestPull = pull
      best = s
    }
  }
  return best
}
