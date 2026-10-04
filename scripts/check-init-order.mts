// Loads every src/game module as the FIRST module of its own fresh native-ESM
// graph. A module whose top level reads a binding from a module still
// mid-initialization (an import cycle) throws a TDZ ReferenceError here, even
// though vitest's module runner would silently hand it `undefined`.
//
//   npx tsx scripts/check-init-order.mts
import { globSync } from 'node:fs'
import { tsImport } from 'tsx/esm/api'

/** Modules that only load under Vite: fixtures.ts calls `import.meta.glob`,
 * and testkit.ts re-exports it. */
const VITE_ONLY = new Set(['src/game/fixtures.ts', 'src/game/testkit.ts'])
const entries = globSync('src/game/**/*.ts').filter(
  (f) => !f.endsWith('.test.ts') && !f.includes('__fixtures__') && !VITE_ONLY.has(f),
)
const failures: { entry: string; error: string }[] = []
for (const entry of entries.sort()) {
  try {
    await tsImport(`../${entry}`, import.meta.url)
  } catch (e) {
    failures.push({ entry, error: String((e as Error).message).split('\n')[0] })
  }
}
console.log(JSON.stringify({ entries: entries.length, failures }))
process.exitCode = failures.length === 0 ? 0 : 1
