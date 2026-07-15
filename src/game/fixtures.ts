// App-safe fixture loader. Committed JSON world snapshots live in
// `./__fixtures__/*.json`; Vite bundles them at build time via `import.meta.glob`
// so this loader is isomorphic (Node test env AND the browser app) and needs no
// filesystem access. Kept vitest-free ON PURPOSE: `main.ts` (`?world=`) imports
// it, so it must not drag test-only deps into the production bundle. The test
// helpers in `./testkit.ts` re-export from here.

import { deserializeWorld, type WorldJson } from './serialize'
import type { World } from './world'

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
