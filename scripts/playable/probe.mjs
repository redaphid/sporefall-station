// Run scripts/playable/probe-run.ts through Vite's module loader, which (unlike
// tsx) understands the `import.meta.glob` the registry and fixtures use.
//   node scripts/playable/probe.mjs <id> [ticks]
import { createServer } from 'vite'

process.env.PROBE_ID = process.argv[2] ?? ''
process.env.PROBE_TICKS = process.argv[3] ?? '300'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } })
try {
  await server.ssrLoadModule('/scripts/playable/probe-run.ts')
} finally {
  await server.close()
}
