# ECS debug harness — how to run

A live bridge into the running game's ECS world (issue #29). Connect over
WebSocket from a CLI or an MCP server to inspect and mutate every entity while
the game plays — on a phone, in a tab, under Vite live-reload.

The phone's webview can't *listen* for connections but can dial **out**, so
everyone meets at a small relay ("the hub") you run on your laptop:

```
  game (webview, ?debug)  ──►  hub (laptop :7810)  ◄──  debuggers (CLI / MCP)
        outbound WS              relay + fan-out           outbound WS
```

- A debugger sends a **verb**; the hub forwards it to the game; the game runs it
  against the live `World` and replies; the hub routes the reply back.
- The game **pushes events** (deaths, hits, pickups…) that the hub fans out to
  every debugger.

## Pieces

| Piece | File | Runs on |
|---|---|---|
| Hub (relay) | `tools/debug-hub/hub.ts` | laptop |
| In-app channel | `src/debug/channel.ts` (verbs: `src/debug/verbs.ts`) | phone/webview, behind `?debug` |
| CLI | `tools/debug-cli/cli.ts` | laptop |
| MCP server | `tools/mcp-debug/server.ts` | laptop |

Everything runs via `npx tsx` (no build step). Ports: hub `7810`, MCP `7811`.

## 1. Start the hub (laptop)

```sh
npx tsx tools/debug-hub/hub.ts          # ws://0.0.0.0:7810
# override: npx tsx tools/debug-hub/hub.ts 7900   or   DEBUG_HUB_PORT=7900 ...
```

## 2. Launch the app with `?debug`

Serve the app from the laptop (`npm run dev`) and open it with `?debug`. The
channel derives the hub URL from whoever served the page, so under live-reload it
"just works":

```
http://<laptop-ip>:5173/?debug            # hub assumed at ws://<laptop-ip>:7810
http://<laptop-ip>:5173/?debug&debugPort=7900   # custom hub port
```

The channel is a **no-op without `?debug`** (dynamically imported only when the
flag is set) and only attaches to sessions that own an authoritative world
(solo / host). On connect it logs `[debug] connected to ws://…` to the console.

## 3. Drive it from the CLI

```sh
npx tsx tools/debug-cli/cli.ts state
npx tsx tools/debug-cli/cli.ts entities
npx tsx tools/debug-cli/cli.ts get 5
npx tsx tools/debug-cli/cli.ts spawn npc cop 20 20
npx tsx tools/debug-cli/cli.ts set 5 '{"health":{"hp":1}}'
npx tsx tools/debug-cli/cli.ts teleport 5 30 30
npx tsx tools/debug-cli/cli.ts kill 5
npx tsx tools/debug-cli/cli.ts --watch          # tail the live event stream
```

Target a non-default hub with `DEBUG_HUB_PORT=7900` or `DEBUG_HUB_URL=ws://host:port`.

## 4. Register the MCP server

Start it (it opens its own debugger connection to the hub):

```sh
npx tsx tools/mcp-debug/server.ts               # http://localhost:7811/mcp
# PORT=7811, hub via DEBUG_HUB_URL / DEBUG_HUB_PORT
```

`.mcp.json` (or any MCP client config) — Streamable HTTP, **not** SSE:

```json
{
  "mcpServers": {
    "sor-ecs-debug": {
      "type": "http",
      "url": "http://localhost:7811/mcp"
    }
  }
}
```

Tools (each a one-liner onto the `raw(verb)` bridge): `list_entities`,
`inspect`, `game_state`, `events`, `set_entity`, `set_field`, `spawn`, `kill`,
`teleport`, `command`.

## The verb surface

Every client speaks the same one-line verb grammar (`runVerb` in
`src/debug/verbs.ts`):

| Verb | Does |
|---|---|
| `entities` | every entity: id, kind, archetype + **verbatim component JSON** (unknown/future components included automatically) |
| `get <id>` | one entity's verbatim JSON |
| `set <id> <jsonPatch>` | deep-merge a JSON patch, coercing scalars to their existing types |
| `spawn <kind> <archetype> <x> <y>` | spawn (npc→fully wired via `spawnNpc`, player→`spawnPlayer`, else a bare entity) |
| `kill <id>` | kill (players are downed, not removed) |
| `teleport <id> <x> <y>` | move + clear interpolation |
| `state` | tick, seed, floor, alarm, gameOver, mission, per-kind counts |
| `events` | recent sim events (bounded ring) |
| `command <verb …>` | escape hatch: run a raw verb line verbatim |

Payloads with spaces/newlines are wrapped `b64:<base64>` on the wire to keep the
verb line safe (`encodeArg`/`decodeArg`); the CLI and WebSocket accept raw JSON
too. Writes are **deferred onto the sim step** (drained between tick and render)
so they never tear a frame; reads answer immediately.

## Verify (no phone needed)

```sh
npx tsx scripts/test/debug-harness-smoke.ts     # hub + real World + real channel + debugger round-trip
npx tsx scripts/test/mcp-debug-smoke.ts         # + MCP server & a real MCP client
npx vitest run src/debug/verbs.test.ts          # verb-handler unit tests
```

## Deferred / out of scope

- **BLE transport** — this task is WebSocket-first; BLE is a separate channel.
- **Auth** — the hub is trust-all on a dev LAN.
- **Reflection "God-view"** (the C# harness's `get_field`/`call_method` over
  arbitrary engine objects) — unneeded here: our entities are plain data, so the
  verbatim mirror already exposes everything.
- **Time-travel / snapshot diffing** — the `state` summary + event stream are
  the primitives; the recorder isn't built.
