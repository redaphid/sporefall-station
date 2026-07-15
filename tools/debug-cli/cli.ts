// One-shot debug CLI. Sends a verb to the game (via the hub) and prints the
// reply; `--watch` instead tails the live event stream.
//
//   npx tsx tools/debug-cli/cli.ts state
//   npx tsx tools/debug-cli/cli.ts entities
//   npx tsx tools/debug-cli/cli.ts spawn npc cop 20 20
//   npx tsx tools/debug-cli/cli.ts set 5 '{"health":{"hp":1}}'
//   npx tsx tools/debug-cli/cli.ts --watch
//
// Hub target: DEBUG_HUB_URL, or DEBUG_HUB_PORT (default ws://127.0.0.1:7810).

import { connectDebugger, defaultHubUrl } from '../debug-client'

const argv = process.argv.slice(2)
const watch = argv[0] === '--watch'
const verb = (watch ? argv.slice(1) : argv).join(' ').trim()

const main = async (): Promise<void> => {
  const client = await connectDebugger()
  if (watch) {
    process.stderr.write(`[cli] watching events on ${defaultHubUrl()} (Ctrl-C to stop)\n`)
    client.onEvent((e) => console.log(JSON.stringify(e)))
    return // keep the process alive on the open socket
  }
  if (!verb) {
    console.error('usage: cli.ts <verb ...>   |   cli.ts --watch')
    process.exit(2)
  }
  try {
    console.log(await client.raw(verb))
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
  client.close()
}

void main()
