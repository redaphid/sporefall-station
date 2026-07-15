// One-shot debug CLI. Sends a verb to the game (via the hub) and prints the
// reply; `--watch` instead tails the live event stream.
//
//   npx tsx tools/debug-cli/cli.ts state
//   npx tsx tools/debug-cli/cli.ts games                 (list connected games)
//   npx tsx tools/debug-cli/cli.ts --game g2 state       (target a specific game)
//   npx tsx tools/debug-cli/cli.ts spawn npc cop 20 20
//   npx tsx tools/debug-cli/cli.ts set 5 '{"health":{"hp":1}}'
//   npx tsx tools/debug-cli/cli.ts dump > world.json     (snapshot the whole world)
//   npx tsx tools/debug-cli/cli.ts load "$(cat world.json)"   (restore it exactly)
//   npx tsx tools/debug-cli/cli.ts step 30               (advance 1s of sim, neutral input)
//   npx tsx tools/debug-cli/cli.ts schema                (live component/archetype shape)
//   npx tsx tools/debug-cli/cli.ts --watch
//
// With exactly one live game connected, no --game is needed. Hub target:
// DEBUG_HUB_URL, or DEBUG_HUB_PORT (default ws://127.0.0.1:7810).

import { connectDebugger, defaultHubUrl } from '../debug-client'
import type { GameInfo } from '../../src/debug/protocol'

// Pull `--game <id>` / `-g <id>` out of argv wherever it appears.
const argv = process.argv.slice(2)
let target: string | undefined
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--game' || argv[i] === '-g') && argv[i + 1]) {
    target = argv[i + 1]
    argv.splice(i, 2)
    i--
  }
}
const watch = argv[0] === '--watch'
const verb = (watch ? argv.slice(1) : argv).join(' ').trim()

const WRITE_VERBS = new Set(['set', 'spawn', 'kill', 'teleport', 'load', 'step', 'tick'])

/** Print a one-line-per-game table so a human can see which game to target. */
const printGames = (games: GameInfo[]): void => {
  if (!games.length) return void console.log('(no games connected)')
  for (const g of games) {
    const flags = [g.live ? 'live' : 'DEAD', g.ticking === null ? 'tick:n/a' : g.ticking ? 'ticking' : 'FROZEN', g.gameOver ? 'gameOver' : ''].filter(Boolean).join(' ')
    console.log(`${g.id}\t${g.name}\ttick=${g.tick ?? '-'}\t${flags}\tseen ${g.lastSeenMs}ms ago`)
  }
}

/** Warn (never block) before mutating a game that looks frozen or ended. */
const warnIfStale = async (games: GameInfo[]): Promise<void> => {
  const g = target ? games.find((x) => x.id === target || x.name === target) : games.length === 1 ? games[0] : undefined
  if (!g) return
  if (g.gameOver) process.stderr.write(`[cli] WARNING: game ${g.id} reports gameOver — the mutation may land in a finished world\n`)
  if (g.ticking === false) process.stderr.write(`[cli] WARNING: game ${g.id} looks FROZEN (tick not advancing) — it may be a backgrounded/orphaned instance\n`)
  if (!g.live) process.stderr.write(`[cli] WARNING: game ${g.id} is not live (stale heartbeat)\n`)
}

const main = async (): Promise<void> => {
  const client = await connectDebugger()
  if (watch) {
    process.stderr.write(`[cli] watching events on ${defaultHubUrl()} (Ctrl-C to stop)\n`)
    client.onEvent((e) => console.log(JSON.stringify(e)))
    return // keep the process alive on the open socket
  }
  if (!verb) {
    console.error('usage: cli.ts [--game <id>] <verb ...>   |   cli.ts games   |   cli.ts --watch')
    process.exit(2)
  }
  try {
    if (verb === 'games') {
      printGames(await client.games())
    } else {
      // Before a mutating verb, warn if the selected game looks frozen/ended so a
      // ghost world never gets silently poked.
      if (WRITE_VERBS.has(verb.split(/\s+/)[0])) await warnIfStale(await client.games()).catch(() => {})
      console.log(await client.raw(verb, { target }))
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
  client.close()
}

void main()
