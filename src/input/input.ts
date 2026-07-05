import type { InputCmd } from '../game/types'

/** Produces one InputCmd per sim tick. Implementations: keyboard (dev), touch (phone). */
export interface InputSource {
  /** Sample current input state. Edge-triggered buttons accumulate between calls. */
  sample(): InputCmd
}
