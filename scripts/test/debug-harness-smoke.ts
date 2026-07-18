// Integration smoke test for the ECS debug harness — proves the whole WS loop
// in Node without a phone. It starts the real hub, wires the REAL in-app
// DebugChannel to a REAL World (running a real tick loop as the "game" side),
// connects a debugger client, and asserts a full round-trip: entities, state,
// set, spawn, and the pushed events stream.
//
//   npx tsx scripts/test/debug-harness-smoke.ts

import { startDebugChannel } from '../../src/debug/channel'
import { hubUrl } from '../../src/debug/protocol'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { createWorld, tickWorld } from '../../src/game/world'
import { startHub } from '../../tools/debug-hub/hub'
import { connectDebugger } from '../../tools/debug-client'

const PORT = Number(process.env.SMOKE_PORT ?? 7899)
const URL = hubUrl('127.0.0.1', PORT)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const waitFor = async (pred: () => boolean, ms = 2000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

const main = async (): Promise<void> => {
  const hub = startHub(PORT, () => {})

  // --- the "game": a real world + real channel + a real tick loop ---
  const world = createWorld(4242, 1)
  spawnPlayer(world, 0, world.level.spawn.x, world.level.spawn.y)
  const civ = spawnNpc(world, 'civilian', 8, 8)
  spawnNpc(world, 'thug', 12, 12)
  const channel = startDebugChannel(world, URL, () => {})
  const loop = setInterval(() => {
    tickWorld(world, new Map())
    channel.afterTick()
  }, 20)

  // --- the debugger ---
  const dbg = await connectDebugger(URL)
  const events: Array<{ type?: string; entityId?: number }> = []
  dbg.onEvent((e) => events.push(e as { type?: string; entityId?: number }))

  // Wait until the game channel has registered with the hub.
  await waitFor(async () => true, 200)
  await sleep(150)

  // 1. entities — verbatim mirror includes every component field
  const list = JSON.parse(await dbg.raw('entities')) as Array<Record<string, unknown>>
  check('entities lists all entities', list.length >= 3, `got ${list.length}`)
  const civRow = list.find((e) => e.id === civ.id)
  check('entity carries verbatim components', !!civRow?.ai && !!civRow?.health, 'ai + health present')

  // 2. state — world summary + counts
  const state = JSON.parse(await dbg.raw('state')) as { seed: number; counts: Record<string, number>; total: number }
  check('state reports seed', state.seed === 4242)
  check('state counts players + npcs', state.counts.player === 1 && state.counts.npc >= 2, JSON.stringify(state.counts))

  // 3. set — deferred write applies and the reply reflects it
  const afterSet = JSON.parse(await dbg.raw(`set ${civ.id} {"health":{"hp":1}}`)) as { health: { hp: number } }
  check('set mutates a component', afterSet.health.hp === 1, `hp=${afterSet.health.hp}`)

  // 4. spawn — a new entity appears
  const spawned = JSON.parse(await dbg.raw('spawn npc cop 20 20')) as { id: number; archetype: string }
  check('spawn creates an entity', spawned.archetype === 'cop' && spawned.id > 0)
  const after = JSON.parse(await dbg.raw('state')) as { total: number }
  check('spawn grows the world', after.total > state.total, `${state.total} -> ${after.total}`)

  // 5. events — a kill streams a death event to the debugger
  await dbg.raw(`kill ${civ.id}`)
  const gotDeath = await waitFor(() => events.some((e) => e.type === 'death' && e.entityId === civ.id))
  check('kill streams a death event', gotDeath, `events seen: ${events.length}`)

  // --- teardown ---
  clearInterval(loop)
  channel.stop()
  dbg.close()
  hub.close()
  await sleep(50)

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
