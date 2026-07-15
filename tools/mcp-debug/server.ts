// MCP server over the LIVE ECS world. Streamable HTTP, stateless — each POST
// gets a fresh McpServer/transport pair wired to ONE shared debugger bridge to
// the hub, so every client drives the same running game. Same transport style
// as the sibling rogue-gm server; every tool is a one-liner onto `raw(verb)`.
//
//   npx tsx tools/mcp-debug/server.ts        (PORT=7811, HUB via DEBUG_HUB_URL)

import { createServer, type Server } from 'node:http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DEFAULT_MCP_PORT, encodeArg } from '../../src/debug/protocol'
import { connectDebugger, defaultHubUrl, type DebugClient } from '../debug-client'

type Raw = (verb: string) => Promise<string>

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const run = async (fn: () => Promise<string>) => {
  try {
    return text(await fn())
  } catch (err) {
    return text(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}
const id = z.union([z.number(), z.string()])

export function buildMcpServer(raw: Raw): McpServer {
  const server = new McpServer({ name: 'sor-ecs-debug', version: '0.1.0' })

  // ---- inspect ----------------------------------------------------------
  server.registerTool('list_entities', { description: 'Every ECS entity: id, kind, archetype, and verbatim component JSON (unknown/future components included).' }, () => run(() => raw('entities')))
  server.registerTool('inspect', { description: "One entity's verbatim component JSON.", inputSchema: { entity: id } }, ({ entity }) => run(() => raw(`get ${entity}`)))
  server.registerTool('game_state', { description: 'World summary: tick, seed, floor, alarm, gameOver, mission, per-kind entity counts.' }, () => run(() => raw('state')))
  server.registerTool('events', { description: 'Recent sim events (deaths, hits, pickups, explosions, ...) from the live event ring.' }, () => run(() => raw('events')))

  // ---- mutate -----------------------------------------------------------
  server.registerTool(
    'set_entity',
    { description: 'Deep-merge a JSON patch into an entity, coercing scalars to their existing types. e.g. patch {"health":{"hp":1}} to one-shot it.', inputSchema: { entity: id, patch: z.string().describe('a JSON object patch') } },
    ({ entity, patch }) => run(() => raw(`set ${entity} ${encodeArg(patch)}`)),
  )
  server.registerTool(
    'set_field',
    { description: 'Set a single dotted field on an entity (sugar over set_entity). e.g. field "health.hp" value "1".', inputSchema: { entity: id, field: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) } },
    ({ entity, field, value }) => {
      // Build a nested JSON object from the dotted path, then delegate to `set`.
      const patch = field.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), value)
      return run(() => raw(`set ${entity} ${encodeArg(JSON.stringify(patch))}`))
    },
  )
  server.registerTool(
    'spawn',
    { description: 'Spawn an entity: kind (npc/player/pickup/...) + archetype (npc archetype like "cop"/"thug", or a player classId) at (x,y).', inputSchema: { kind: z.string(), archetype: z.string(), x: z.number(), y: z.number() } },
    ({ kind, archetype, x, y }) => run(() => raw(`spawn ${kind} ${archetype} ${x} ${y}`)),
  )
  server.registerTool('kill', { description: 'Kill an entity (players are downed, not removed).', inputSchema: { entity: id } }, ({ entity }) => run(() => raw(`kill ${entity}`)))
  server.registerTool('teleport', { description: 'Teleport an entity to (x,y).', inputSchema: { entity: id, x: z.number(), y: z.number() } }, ({ entity, x, y }) => run(() => raw(`teleport ${entity} ${x} ${y}`)))

  // ---- session / lobby (headless harness backend) -----------------------
  // These verbs only resolve when the connected `game` is a GameHarness (see
  // tools/debug-harness/host.ts); against a live phone/world they error cleanly.
  server.registerTool('session_create', { description: 'Create/host a headless game in the lobby (mode is co-op host). Pick a player class + seed.', inputSchema: { classId: z.string(), seed: z.number(), name: z.string().optional() } }, ({ classId, seed, name }) => run(() => raw(`create ${classId} ${seed}${name ? ` ${name}` : ''}`)))
  server.registerTool('session_join_bot', { description: 'Add a bot player driven by programmatic/scripted InputCmds. Returns its slot.', inputSchema: { name: z.string(), classId: z.string(), script: z.string().optional().describe('optional named input script (e.g. "demo")') } }, ({ name, classId, script }) => run(() => raw(`join_bot ${name} ${classId}${script ? ` ${script}` : ''}`)))
  server.registerTool('session_remove_bot', { description: 'Remove a bot player by slot.', inputSchema: { slot: z.number() } }, ({ slot }) => run(() => raw(`remove_bot ${slot}`)))
  server.registerTool('session_start', { description: 'Start the run: spawn every lobby player and begin ticking.' }, () => run(() => raw('start_run')))
  server.registerTool('session_lobby', { description: 'List lobby players (slot, name, class, bot).' }, () => run(() => raw('lobby')))
  server.registerTool('session_phase', { description: 'Session phase + current tick/floor/gameOver.' }, () => run(() => raw('phase')))
  server.registerTool('bot_input', { description: 'Set a slot\'s next InputCmd (slot 0 = host). Latest-write-wins, like a remote player.', inputSchema: { slot: z.number(), cmd: z.string().describe('a JSON InputCmd patch, e.g. {"moveX":1,"attack":true}') } }, ({ slot, cmd }) => run(() => raw(`input ${slot} ${encodeArg(cmd)}`)))
  server.registerTool('advance', { description: 'Advance the sim N ticks (30 = 1s), applying each slot\'s current input.', inputSchema: { ticks: z.number() } }, ({ ticks }) => run(() => raw(`tick ${ticks}`)))

  // ---- record / replay / fixtures ---------------------------------------
  server.registerTool('record_start', { description: 'Begin recording the initial snapshot + per-tick inputs + events (must be at tick 0).' }, () => run(() => raw('record_start')))
  server.registerTool('record_stop', { description: 'Stop recording and return the Recording JSON (feed it to replay).' }, () => run(() => raw('record_stop')))
  server.registerTool('replay', { description: 'Re-run a Recording deterministically and assert the final state/events match.', inputSchema: { recording: z.string().describe('a Recording JSON string from record_stop') } }, ({ recording }) => run(() => raw(`replay ${encodeArg(recording)}`)))
  server.registerTool('save_world', { description: 'Dump the full world as a fixture (scenario starting point).' }, () => run(() => raw('save')))
  server.registerTool('load_world', { description: 'Restore a world fixture in place.', inputSchema: { fixture: z.string().describe('a WorldFixture JSON string from save_world') } }, ({ fixture }) => run(() => raw(`load ${encodeArg(fixture)}`)))

  // ---- escape hatch -----------------------------------------------------
  server.registerTool('command', { description: 'Send a raw verb line verbatim to the game (see docs/ecs-debug-harness.md for the verb surface).', inputSchema: { verb: z.string() } }, ({ verb }) => run(() => raw(verb)))

  return server
}

export function startServer(raw: Raw, port: number): Promise<Server> {
  const httpServer = createServer(async (req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return void res.writeHead(404).end()
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end()
    const server = buildMcpServer(raw)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error('mcp request failed:', err)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
  return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer)))
}

/** Connect the shared debugger bridge to the hub, then serve MCP on `port`. */
export async function main(port = Number(process.env.PORT ?? DEFAULT_MCP_PORT)): Promise<{ server: Server; bridge: DebugClient }> {
  const bridge = await connectDebugger()
  const server = await startServer((verb) => bridge.raw(verb), port)
  console.log(`sor-ecs-debug mcp on http://localhost:${port}/mcp (hub: ${defaultHubUrl()})`)
  return { server, bridge }
}

// Run directly (`npx tsx tools/mcp-debug/server.ts`) → start immediately.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
