// Test helpers for the "load JSON world → act/tick → assert JSON world" pattern.
// Committed fixtures live in `./__fixtures__/*.json`; a test loads one, drives a
// few ticks (or a dispatched action), and asserts the resulting snapshot against
// another fixture. This module is imported only by tests — never by the app.

import { expect } from 'vitest'
import { serializeWorld } from './serialize'
import { emptyInput, type InputCmd } from './types'
import { tickWorld, type World } from './world'

// The fixture loaders live in the vitest-free `./fixtures.ts` (the app's
// `?world=` boot hook imports them too); re-export so tests keep one import site.
export { loadFixture, loadFixtureJson } from './fixtures'

/** Tick a world `n` times, feeding a fresh, defaulted clone of `inputs` each tick
 * (partial commands are filled from `emptyInput`). Returns the world for chaining. */
export const runTicks = (w: World, inputs: Map<number, Partial<InputCmd>>, n: number): World => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([...inputs].map(([slot, cmd]) => [slot, { ...emptyInput(), ...cmd }])))
  }
  return w
}

/** Assert two worlds are in an identical state by comparing their snapshots. */
export const expectWorldEqual = (a: World, b: World): void => {
  expect(serializeWorld(a)).toEqual(serializeWorld(b))
}
