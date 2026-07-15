// End-to-end proof of the MCP layer: hub + real game world + MCP server + a real
// MCP client (Streamable HTTP). Lists the tools, then calls game_state, spawn,
// and inspect through the MCP → hub → game bridge.
//
//   npx tsx scripts/test/mcp-debug-smoke.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startDebugChannel } from '../../src/debug/channel'
import { hubUrl } from '../../src/debug/protocol'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { createWorld, tickWorld } from '../../src/game/world'
import { startHub } from '../../tools/debug-hub/hub'
import { main as startMcp } from '../../tools/mcp-debug/server'

const HUB_PORT = Number(process.env.SMOKE_HUB_PORT ?? 7898)
const MCP_PORT = Number(process.env.SMOKE_MCP_PORT ?? 7897)
const HUB_WS = hubUrl('127.0.0.1', HUB_PORT)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const textOf = (r: unknown): string => {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return c.map((b) => b.text ?? '').join('')
}

const main = async (): Promise<void> => {
  process.env.DEBUG_HUB_URL = HUB_WS
  const hub = startHub(HUB_PORT, () => {})

  // game side
  const world = createWorld(777, 1)
  spawnPlayer(world, 0, 'soldier', world.level.spawn.x, world.level.spawn.y)
  spawnNpc(world, 'cop', 6, 6)
  const channel = startDebugChannel(world, HUB_WS, () => {})
  const loop = setInterval(() => {
    tickWorld(world, new Map())
    channel.afterTick()
  }, 20)

  // MCP server (bridge → hub) + a real MCP client
  const mcp = await startMcp(MCP_PORT)
  const client = new Client({ name: 'smoke', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)))

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)
  check('tools/list exposes the surface', ['list_entities', 'inspect', 'game_state', 'spawn', 'kill', 'teleport', 'command'].every((n) => names.includes(n)), names.join(','))

  const state = JSON.parse(textOf(await client.callTool({ name: 'game_state', arguments: {} }))) as { seed: number }
  check('game_state via MCP', state.seed === 777, `seed=${state.seed}`)

  const spawned = JSON.parse(textOf(await client.callTool({ name: 'spawn', arguments: { kind: 'npc', archetype: 'thug', x: 9, y: 9 } }))) as { id: number; archetype: string }
  check('spawn via MCP', spawned.archetype === 'thug' && spawned.id > 0, `id=${spawned.id}`)

  const inspected = JSON.parse(textOf(await client.callTool({ name: 'inspect', arguments: { entity: spawned.id } }))) as { archetype: string }
  check('inspect via MCP', inspected.archetype === 'thug')

  const setRep = JSON.parse(textOf(await client.callTool({ name: 'set_field', arguments: { entity: spawned.id, field: 'health.hp', value: 2 } }))) as { health: { hp: number } }
  check('set_field via MCP', setRep.health.hp === 2, `hp=${setRep.health.hp}`)

  await client.close()
  clearInterval(loop)
  channel.stop()
  mcp.bridge.close()
  mcp.server.close()
  hub.close()
  await new Promise((r) => setTimeout(r, 50))

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
