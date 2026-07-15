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
