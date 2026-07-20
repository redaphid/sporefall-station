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
  const server = new McpServer({ name: 'sporefall-ecs-debug', version: '0.1.0' })

  // ---- game selection (multi-game hubs) ---------------------------------
  // A hub may host several games; these pick which one the other tools drive.
  // With exactly one live game, selection is unnecessary.
  server.registerTool('games', { description: 'List games connected to the hub: id, name, live?, ticking? (frozen = backgrounded/orphaned), gameOver, last-seen.' }, () => run(() => raw('games')))
  server.registerTool('select_game', { description: 'Route subsequent verbs to a specific game by id/name (sticky for this session). Use when the hub reports multiple games.', inputSchema: { game: z.string().describe('a game id (e.g. "g2") or name from `games`') } }, ({ game }) => run(() => raw(`use ${game}`)))

  // ---- inspect ----------------------------------------------------------
  server.registerTool('list_entities', { description: 'Every ECS entity: id, kind, archetype, and verbatim component JSON (unknown/future components included).' }, () => run(() => raw('entities')))
  server.registerTool('inspect', { description: "One entity's verbatim component JSON.", inputSchema: { entity: id } }, ({ entity }) => run(() => raw(`get ${entity}`)))
  server.registerTool('game_state', { description: 'World summary: tick, seed, floor, alarm, gameOver, mission, per-kind entity counts.' }, () => run(() => raw('state')))
  server.registerTool('events', { description: 'Recent sim events (deaths, hits, pickups, explosions, ...) from the live event ring.' }, () => run(() => raw('events')))
  server.registerTool('dump_world', { description: 'Lossless snapshot of the WHOLE live world as WorldJson (serialize.ts): entities + RNG stream position + mission/alarm/tick. Feed the exact string back to restore_world for a byte-identical restore.' }, () => run(() => raw('dump')))
  server.registerTool('schema', { description: 'Reflection: the live component/archetype shape of the world (kinds, archetypes, and every top-level entity field with its types + nested keys), derived from the actual entities so unfamiliar/new components are enumerated dynamically. Use it to reason about entities you have not seen before.' }, () => run(() => raw('schema')))

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
    { description: 'Spawn an entity: kind (npc/player/pickup/...) + archetype (npc archetype like "cop"/"thug"; ignored for kind "player") at (x,y).', inputSchema: { kind: z.string(), archetype: z.string(), x: z.number(), y: z.number() } },
    ({ kind, archetype, x, y }) => run(() => raw(`spawn ${kind} ${archetype} ${x} ${y}`)),
  )
  server.registerTool('kill', { description: 'Kill an entity (players are downed, not removed).', inputSchema: { entity: id } }, ({ entity }) => run(() => raw(`kill ${entity}`)))
  server.registerTool(
    'add_mod',
    {
      description:
        "Stack a ROUNDS-style weapon MOD onto an entity's slotted gun (data/mods.ts): registry-checked + stack-capped. Composes at the single fire site via resolveWeapon — inspect the result with `inspect`. e.g. modId \"frost\" (freeze), \"bounce\" (ricochet), \"explosive\", \"lifesteal\", \"homing\", \"overload\" (+damage). Known ids: bounce, bulk, choke, detonator, explosive, frost, glassCannon, heavy, homing, incendiary, lifesteal, overload, pierce, rapid, shock, split, velocity.",
      inputSchema: { entity: id, modId: z.string(), stacks: z.number().int().positive().optional() },
    },
    ({ entity, modId, stacks }) => run(() => raw(`addMod ${entity} ${modId}${stacks ? ` ${stacks}` : ''}`)),
  )

  // ---- communicate: draw on screen + read the player's selection -------------
  server.registerTool(
    'annotate',
    {
      description:
        'Draw inert on-screen annotation(s) OVER the live scene (does not affect the sim). The recommended, engine-positioned form anchors to an entity: {"kind":"label","targetId":47,"text":"boss — hits hard"} — the overlay places the text over that entity\'s live sprite and follows it. Free-floating marks use a world point (or screen point for kind "text"): kinds are label/pin/arrow/circle/text; every kind also takes an optional "text" caption; optional "color" (CSS), "ttlTick" (absolute tick to expire), "radius" (circle), "x2"/"y2" (arrow tail). Pass one object or a JSON array of them.',
      inputSchema: { annotations: z.string().describe('a JSON Annotation object or an array of them') },
    },
    ({ annotations }) => run(() => raw(`annotate ${encodeArg(annotations)}`)),
  )
  server.registerTool(
    'clear_annotations',
    { description: 'Remove all on-screen annotations, or just one by id.', inputSchema: { id: id.optional().describe('annotation id; omit to clear all') } },
    ({ id: aid }) => run(() => raw(`clearAnnotations${aid === undefined ? '' : ` ${aid}`}`)),
  )
  server.registerTool(
    'list_selected',
    { description: 'The entities the player has SELECTED (tapped to point out), with full component JSON. Selection is a normal per-entity flag, so this is just `entities` filtered to selected — use it to resolve "this one" from the player.' },
    () => run(() => raw('entities selected')),
  )
  server.registerTool('teleport', { description: 'Teleport an entity to (x,y).', inputSchema: { entity: id, x: z.number(), y: z.number() } }, ({ entity, x, y }) => run(() => raw(`teleport ${entity} ${x} ${y}`)))
  server.registerTool(
    'restore_world',
    { description: 'Replace the live world EXACTLY from a WorldJson snapshot (from dump_world), in place. Prototype-pollution-guarded. Use this to set world state precisely before inspecting/stepping.', inputSchema: { world: z.string().describe('a WorldJson string from dump_world') } },
    ({ world }) => run(() => raw(`load ${encodeArg(world)}`)),
  )
  server.registerTool(
    'step',
    { description: 'Advance the LIVE world N deterministic ticks with neutral input (no player commands); 30 ticks = 1s. The RNG stream is the only entropy, so a stepped world stays reproducible. Default 1.', inputSchema: { ticks: z.number().int().nonnegative().optional() } },
    ({ ticks }) => run(() => raw(`step ${ticks ?? 1}`)),
  )

  // ---- session / lobby (headless harness backend) -----------------------
  // These verbs only resolve when the connected `game` is a GameHarness (see
  // tools/debug-harness/host.ts); against a live phone/world they error cleanly.
  server.registerTool('session_create', { description: 'Create/host a headless game in the lobby (mode is co-op host). Pick a seed.', inputSchema: { seed: z.number(), name: z.string().optional() } }, ({ seed, name }) => run(() => raw(`create ${seed}${name ? ` ${name}` : ''}`)))
  server.registerTool('session_join_bot', { description: 'Add a bot player driven by programmatic/scripted InputCmds. Returns its slot.', inputSchema: { name: z.string(), script: z.string().optional().describe('optional named input script (e.g. "demo")') } }, ({ name, script }) => run(() => raw(`join_bot ${name}${script ? ` ${script}` : ''}`)))
  server.registerTool('session_remove_bot', { description: 'Remove a bot player by slot.', inputSchema: { slot: z.number() } }, ({ slot }) => run(() => raw(`remove_bot ${slot}`)))
  server.registerTool('session_start', { description: 'Start the run: spawn every lobby player and begin ticking.' }, () => run(() => raw('start_run')))
  server.registerTool('session_lobby', { description: 'List lobby players (slot, name, bot).' }, () => run(() => raw('lobby')))
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

/** Bind the MCP HTTP server on `port`, then wire it to the shared debugger
 * bridge. The bridge connects to the hub in the BACKGROUND (self-healing with
 * backoff), so this resolves — and the port serves — even when the hub is down;
 * verbs fail fast with a clear error until the hub is reachable. */
export async function main(port = Number(process.env.PORT ?? DEFAULT_MCP_PORT)): Promise<{ server: Server; bridge: DebugClient }> {
  const bridge = await connectDebugger()
  const server = await startServer((verb) => bridge.raw(verb), port)
  console.log(`sporefall-ecs-debug mcp on http://localhost:${port}/mcp (hub: ${defaultHubUrl()})`)
  return { server, bridge }
}

// Run directly (`npx tsx tools/mcp-debug/server.ts`) → start immediately.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
