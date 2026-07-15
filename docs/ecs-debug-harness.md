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

## Session / lobby + record & replay (issue #44)

On top of the world verbs, a headless **GameHarness** (`src/debug/harness.ts`)
drives a whole co-op session — no phone, no render loop. It wraps a
`HostSession` (the authoritative sim) with a lobby lifecycle and a recorder, and
bot players are extra slots whose per-tick command is deposited into
`HostSession.remoteInputs` — exactly where the real net layer puts remote
players, so the sim path is identical. `runHarnessVerb` exposes it over the same
verb grammar (unknown verbs fall through to the world surface above):

| Verb | Does |
|---|---|
| `create <classId> <seed> [name]` | create/host a game in the lobby |
| `join_bot <name> <classId> [script]` | add a bot player (programmatic/scripted input); returns its slot |
| `remove_bot <slot>` | remove a bot + kill its avatar |
| `start_run` | spawn every lobby player, begin ticking |
| `lobby` / `phase` | query players / phase+tick+floor |
| `input <slot> <jsonCmd>` | set a slot's next `InputCmd` (slot 0 = host), latest-write-wins |
| `tick [n]` | advance the sim n ticks |
| `record_start` / `record_stop` | record the genesis snapshot + per-tick inputs + events → `Recording` JSON |
| `replay <recording>` | re-run a `Recording` and assert final state + events match |
| `save` / `load <fixture>` | dump / restore the full world (scenario fixtures) |

Run a whole session headless via the same hub the phone uses — start the relay,
attach the harness backend, then drive it from the CLI/MCP:

```sh
npx tsx tools/debug-hub/hub.ts &            # the relay
npx tsx tools/debug-harness/host.ts         # the headless "game" backend (a GameHarness)
npx tsx tools/debug-cli/cli.ts create soldier 42
npx tsx tools/debug-cli/cli.ts join_bot Bravo thief
npx tsx tools/debug-cli/cli.ts start_run
npx tsx tools/debug-cli/cli.ts record_start
npx tsx tools/debug-cli/cli.ts tick 300
npx tsx tools/debug-cli/cli.ts record_stop > run.json
```

The MCP server re-exposes these as `session_create` / `session_join_bot` /
`session_start` / `bot_input` / `advance` / `record_start` / `record_stop` /
`replay` / `save_world` / `load_world`.

**Determinism.** The world is a pure function of `(seed → forked RNG)` + the
per-tick `InputCmd` map (the sim forbids `Date.now()`/`Math.random()`,
eslint-guarded). The recorder captures the exact input map fed to `tickWorld`
each tick (via a `HostSession.onTickInputs` hook) plus that tick's `w.events`.
`replay` rebuilds the world from the seed + genesis player seeds and re-feeds the
recorded inputs — inputs are the only entropy, so it reproduces the same
entities and events bit-for-bit. (`save`/`load` fixtures re-fork the RNG from
seed+floor, so they are scenario *starting points*, not bit-exact continuations;
replay never uses that path.)

## In-app channel auto-reconnect

`startDebugChannel` now re-dials the hub with exponential backoff (base 500ms →
cap 8s) when the socket drops on HMR reloads / idle timeouts, so long
e2e/record sessions survive. `stop()` cancels any pending retry; pass
`{ reconnect: false }` to opt out (and `WebSocketImpl` to inject a socket in
tests).

## Verify (no phone needed)

```sh
npx tsx scripts/test/debug-harness-smoke.ts     # hub + real World + real channel + debugger round-trip
npx tsx scripts/test/mcp-debug-smoke.ts         # + MCP server & a real MCP client
npx tsx scripts/test/harness-e2e.ts             # full co-op flow + record/replay determinism + loopback net joiners
npx tsx scripts/test/harness-channel-smoke.ts   # CLI/MCP → hub → harness over a real WebSocket
npx vitest run src/debug/                        # verb / harness / record / channel unit tests
```

## Deferred / out of scope

- **BLE transport** — this task is WebSocket-first; BLE is a separate channel.
- **Auth** — the hub is trust-all on a dev LAN.
- **Reflection "God-view"** (the C# harness's `get_field`/`call_method` over
  arbitrary engine objects) — unneeded here: our entities are plain data, so the
  verbatim mirror already exposes everything.
