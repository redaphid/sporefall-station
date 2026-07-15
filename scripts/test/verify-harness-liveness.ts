// End-to-end verification of issue #45 over REAL production pieces (no fakes):
// the actual hub, two actual in-app DebugChannels (each with a ?debug=<name>),
// and the actual debugger client the CLI/MCP use. Proves multi-game identity,
// liveness-based staleness, targeted routing, and self-removal — all in Node.
//
//   npx tsx scripts/test/verify-harness-liveness.ts

import { createWorld, tickWorld, type World } from '../../src/game/world'
import { startDebugChannel } from '../../src/debug/channel'
import { startHub } from '../../tools/debug-hub/hub'
import { connectDebugger } from '../../tools/debug-client'
import type { GameInfo } from '../../src/debug/protocol'

const PORT = 7830
const URL = `ws://127.0.0.1:${PORT}`
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}\t${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const main = async (): Promise<void> => {
  const hub = startHub(PORT, { log: () => {}, staleMs: 400, frozenMs: 400 })

  // Two independent games on ONE hub — the co-op / multi-dev case.
  const alice = createWorld(111, 1)
  const bob = createWorld(222, 1)
  const chA = startDebugChannel(alice, URL, () => {}, { name: 'alice', heartbeatMs: 40 })
  const chB = startDebugChannel(bob, URL, () => {}, { name: 'bob', heartbeatMs: 40 })

  // Drive both sims so their ticks advance (proves "ticking").
  const drive = { a: true, b: true }
  const loop = setInterval(() => {
    if (drive.a) {
      tickWorld(alice, new Map())
      chA.afterTick()
    }
    if (drive.b) {
      tickWorld(bob, new Map())
      chB.afterTick()
    }
  }, 20)

  const dbg = await connectDebugger(URL)
  await sleep(150) // let hellos + a few heartbeats land

  // 1. Both games registered, neither evicted the other.
  let games = await dbg.games()
  check('both games listed (no eviction)', games.map((g) => g.name).sort().join(',') === 'alice,bob', JSON.stringify(games.map((g) => g.name)))
  check('both games live + ticking', games.every((g) => g.live && g.ticking === true))

  // 2. Ambiguous with two live games — must NOT silently pick one.
  const ambiguous = await dbg.raw('state').then(() => 'routed', (e: Error) => e.message)
  check('no-target verb refuses to guess', /multiple games/.test(ambiguous), ambiguous)

  // 3. Targeted routing hits the intended world (by id and by name).
  const g1 = games.find((g) => g.name === 'alice')!.id
  const stateA = JSON.parse(await dbg.raw('state', { target: g1 })) as { seed: number }
  const stateB = JSON.parse(await dbg.raw('state', { target: 'bob' })) as { seed: number }
  check('target=id routes to alice', stateA.seed === 111, `seed=${stateA.seed}`)
  check('target=name routes to bob', stateB.seed === 222, `seed=${stateB.seed}`)

  // 4. Freeze alice (stop advancing her tick) → hub marks her stale by liveness.
  drive.a = false
  await sleep(600) // > frozenMs; alice keeps the SAME tick, bob advances
  games = await dbg.games()
  const aRow = games.find((g) => g.name === 'alice') as GameInfo
  const bRow = games.find((g) => g.name === 'bob') as GameInfo
  check('frozen alice flagged not-ticking + not-live', aRow.ticking === false && !aRow.live, JSON.stringify(aRow))
  check('bob still live', bRow.live && bRow.ticking === true)

  // 5. With only one LIVE game, default routing "just works" again — on bob.
  const dflt = JSON.parse(await dbg.raw('state')) as { seed: number }
  check('default routing picks the single live game (bob)', dflt.seed === 222, `seed=${dflt.seed}`)

  // 6. Self-removal: alice's channel closes its socket (as pagehide/hidden does)
  //    → the hub drops her entirely, leaving no ghost to latch onto.
  chA.stop()
  await sleep(150)
  games = await dbg.games()
  check('stopped channel removed from the registry', games.map((g) => g.name).join(',') === 'bob', JSON.stringify(games.map((g) => g.name)))

  clearInterval(loop)
  chB.stop()
  dbg.close()
  await new Promise((r) => hub.close(r))
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

void main()
