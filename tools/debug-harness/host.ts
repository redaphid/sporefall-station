// Headless harness backend. Registers with the hub as the `game`, but instead of
// a live phone world it drives a GameHarness — so the CLI and MCP can create a
// session, join bot players, start, run a scenario, and record/replay entirely
// in Node, no device attached.
//
//   npx tsx tools/debug-hub/hub.ts &                 (the relay)
//   npx tsx tools/debug-harness/host.ts              (this backend)
//   npx tsx tools/debug-cli/cli.ts create soldier 42
//   npx tsx tools/debug-cli/cli.ts join_bot Bob soldier
//   npx tsx tools/debug-cli/cli.ts start_run
//   npx tsx tools/debug-cli/cli.ts tick 300
//   npx tsx tools/debug-cli/cli.ts state
//
// Hub target: DEBUG_HUB_URL, or DEBUG_HUB_PORT (default ws://127.0.0.1:7810).

import { startHarnessChannel } from '../../src/debug/channel'
import { GameHarness } from '../../src/debug/harness'
import { DEFAULT_HUB_PORT, hubUrl } from '../../src/debug/protocol'

const url = process.env.DEBUG_HUB_URL ?? hubUrl('127.0.0.1', Number(process.env.DEBUG_HUB_PORT ?? DEFAULT_HUB_PORT))

const harness = new GameHarness()
const channel = startHarnessChannel(harness, url, (m) => console.log(m))

console.log(`sor debug harness backend → ${url}`)
console.log('drive it with tools/debug-cli/cli.ts (create / join_bot / start_run / tick / record_start …)')

process.on('SIGINT', () => {
  channel.stop()
  process.exit(0)
})
