// A playable scenario: a world to drop into from the start menu's "Test
// scenarios" list, plus the words and picture that tell the player what it is
// for. One shape for every source of a world:
//
//   fixture  a committed WorldJson in src/game/__fixtures__/ — an authored
//            world (scripts/playable/<id>.mts), a crafted save, or the fixture
//            a mechanic test asserts on
//   preset   a `?scenario=` stage (src/game/scenarios.ts) on a seeded run
//   run      a real run start: seed + floor + loadout + hp. The exit goes on to
//            the next floor through the normal progression, so it plays on
//
// Plain data. The menu list imports it; src/playable/start.ts turns `start`
// into a World; src/playable/playable.test.ts runs every entry.

import type { ItemStack } from '../game/entity'
import type { BotPlan } from '../scenes/bot'

/** The list's headings, in the order the list shows them. */
export const SECTIONS = {
  new: 'New today',
  systems: 'Systems',
  builds: 'Weapon builds',
  areas: 'Areas & floors',
} as const
export type Section = keyof typeof SECTIONS

export type PlayStart =
  | { readonly kind: 'fixture'; readonly fixture: string }
  | { readonly kind: 'preset'; readonly preset: string; readonly seed: number; readonly floor?: number }
  | {
      readonly kind: 'run'
      readonly seed: number
      readonly floor: number
      /** Replaces the player's inventory: the first stack is the gun. */
      readonly loadout?: readonly ItemStack[]
      /** Max and current hp. */
      readonly hp?: number
    }

export interface Playable {
  /** Kebab-case, and the file name under src/playable/entries/. */
  readonly id: string
  readonly title: string
  /** One short line under the title. */
  readonly subtitle: string
  /** What mechanic or system this exercises, in player words. */
  readonly tests: string
  /** What to watch for while playing it. */
  readonly lookFor: string
  readonly section: Section
  /** Short chips: the system, the enemies, the weapon. */
  readonly tags: readonly string[]
  readonly start: PlayStart
  /** The card's picture: the sim tick the action happens at (the capture
   * script shoots it there) and an optional camera zoom. */
  readonly shot: { readonly tick: number; readonly zoom?: number }
  /** An optional scripted player for the capture and the determinism test:
   * the same bot drives both, so the picture shows the tested beat. A player
   * opening the scenario plays it themselves. */
  readonly demo?: BotPlan
}

/** The card picture, relative to the page, so a beta under /betas/<slug>/
 * serves its own. */
export const shotPath = (id: string): string => `playable/${id}.webp`

/** The link that opens a scenario in play. Relative for the same reason. */
export const playHref = (id: string): string => `./?play=${encodeURIComponent(id)}`
