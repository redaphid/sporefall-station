// Test helpers for the "load JSON world → act/tick → assert JSON world" pattern.
// Committed fixtures live in `./__fixtures__/*.json`; a test loads one, drives a
// few ticks (or a dispatched action), and asserts the resulting snapshot against
// another fixture. This module is imported only by tests — never by the app.

import { expect } from 'vitest'
import { deserializeWorld, serializeWorld, type WorldJson } from './serialize'
import { emptyInput, type InputCmd } from './types'
import { tickWorld, type World } from './world'

// Vite bundles the fixtures at build time, so no filesystem access is needed and
// the loader stays isomorphic (works the same under Node and the browser test env).
const fixtures = import.meta.glob('./__fixtures__/*.json', { eager: true, import: 'default' }) as Record<
  string,
  WorldJson
>

/** Read a committed fixture as its raw JSON snapshot (a fresh, mutation-safe copy). */
export const loadFixtureJson = (name: string): WorldJson => {
  const j = fixtures[`./__fixtures__/${name}.json`]
  if (!j) throw new Error(`no such fixture: ${name}`)
  // Clone — the imported module object is shared, and callers (and the sim) mutate.
  return JSON.parse(JSON.stringify(j)) as WorldJson
}

/** Read a committed fixture and rehydrate it into a live, standalone world. */
export const loadFixture = (name: string): World => deserializeWorld(loadFixtureJson(name))

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
