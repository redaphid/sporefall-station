// Standalone vitest config for the observer's pure-core tests. The ROOT config
// (vite.config.ts `test.include`) deliberately covers only src/** — this file
// exists so tools/observer gets tested without touching that suite:
//
//   pnpm exec vitest run --config tools/observer/vitest.config.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pin the root to THIS directory — otherwise vitest roots at the invoking
  // cwd (the repo), sweeps up the whole src suite, and runs it without the
  // root config's long testTimeout.
  root: path.dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
})
