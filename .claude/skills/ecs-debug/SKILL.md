---
name: ecs-debug
description: Attach to the running Sporefall Station ECS engine to inspect, mutate, snapshot/restore, and single-step the live world. Use when debugging or reasoning about game runtime state — connecting via the debug hub/CLI/MCP, dumping or loading an exact WorldJson, stepping N ticks, reading entities/events, discovering component shape via the schema verb, or attaching a real JS debugger with `node --inspect`. Ports: hub 7810, MCP 7811.
---

# ECS debug: attach & inspect the live world

A deterministic ECS sim with a live WebSocket debug bridge. Everything runs via
`npx tsx` (no build step). Reference: `docs/ecs-debugging.md` (contract +
determinism) and `docs/ecs-debug-harness.md` (transport + harness verbs).

Ports: **hub 7810**, **MCP 7811**. The debug surface is dev-only (behind
`?debug`) and never in a release build.

## 1. Start the hub (relay, on the laptop)

```sh
npx tsx tools/debug-hub/hub.ts            # ws://0.0.0.0:7810
```

## 2. Connect a "game" — pick ONE

**A. A real/live game (phone or browser tab):** serve the app and open it with
`?debug`. The channel dials the hub derived from whoever served the page.

```sh
npm run dev                               # then open http://<laptop-ip>:5173/?debug
```

**B. Headless (no phone, no render loop):** attach the harness backend — a full
co-op session driven by verbs.

```sh
npx tsx tools/debug-harness/host.ts       # registers as a "game" on the hub
```

Confirm what's connected:

```sh
npx tsx tools/debug-cli/cli.ts games      # id, name, live?, ticking?, gameOver, last-seen
```

## 3. Drive it — CLI (one-shot verbs)

```sh
npx tsx tools/debug-cli/cli.ts state                    # tick/seed/floor/counts summary
npx tsx tools/debug-cli/cli.ts schema                   # live component/archetype shape
npx tsx tools/debug-cli/cli.ts entities                 # every entity, verbatim JSON
npx tsx tools/debug-cli/cli.ts get 5                    # one entity
npx tsx tools/debug-cli/cli.ts set 5 '{"health":{"hp":1}}'   # deep-merge a patch
npx tsx tools/debug-cli/cli.ts spawn npc cop 20 20
npx tsx tools/debug-cli/cli.ts teleport 5 30 30
npx tsx tools/debug-cli/cli.ts kill 5
npx tsx tools/debug-cli/cli.ts --watch                  # tail the live event stream
# target a specific game on a multi-game hub:  --game g2 <verb>
# non-default hub:  DEBUG_HUB_PORT=7900  or  DEBUG_HUB_URL=ws://host:port
```

## 4. Snapshot / inject an EXACT world state

`dump` → lossless `WorldJson` (entities + RNG stream position). `load` restores
it exactly, in place — byte-identical on every subsequent tick. Use it to pin a
scenario and reset to it precisely.

```sh
npx tsx tools/debug-cli/cli.ts dump > world.json                 # snapshot everything
npx tsx tools/debug-cli/cli.ts load "$(cat world.json)"          # restore it exactly
```

## 5. Single-step the sim

`step [n]` (alias `tick`) advances `n` deterministic ticks with neutral input
(default 1). 30 ticks = 1s.

```sh
npx tsx tools/debug-cli/cli.ts step        # 1 tick
npx tsx tools/debug-cli/cli.ts step 30     # ~1 second of sim
npx tsx tools/debug-cli/cli.ts state       # observe the advance
```

Loop `load world.json` → tweak with `set`/`spawn` → `step N` → `dump`/`state` to
run a controlled, reproducible experiment.

## 6. Read runtime state via MCP (for Claude)

Start the server (opens its own debugger link to the hub):

```sh
npx tsx tools/mcp-debug/server.ts          # http://localhost:7811/mcp
```

`.mcp.json` — Streamable HTTP, **not** SSE:

```json
{ "mcpServers": { "sporefall-ecs-debug": { "type": "http", "url": "http://localhost:7811/mcp" } } }
```

Tools: `game_state`, `schema`, `list_entities`, `inspect`, `events`,
`dump_world`, `restore_world`, `step`, `set_entity`, `set_field`, `spawn`,
`kill`, `teleport`, `command`, plus the session/record tools
(`session_create` … `replay`, `save_world`, `load_world`).

## 7. Reason about unfamiliar entities

Run `schema` for the world's shape (kinds, archetypes, every component field with
its types + nested keys — derived from live entities, so new components appear
automatically), then `get <id>` for one entity's actual values. Cross-reference
the two.

## 8. Attach a REAL JS debugger (breakpoints in the sim)

`scripts/test/inspect-world.ts` loads a `WorldJson` and runs the pure sim
headless — no render/net — so you can break inside `src/game/**`.

```sh
# run it:
npx tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
npx tsx scripts/test/inspect-world.ts --new 20260715 1 30

# debug it (Chrome DevTools / VS Code):
node --inspect-brk --import tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
#   → open chrome://inspect, click "inspect". Pauses at the `debugger` line with
#     `world` loaded; set breakpoints in src/game/** and resume. Each tickWorld
#     runs the whole sim step under the debugger.
```

Grab a live world first with `... cli.ts dump > world.json` and pass it in.

## Verify the harness itself

```sh
npx vitest run src/debug/                             # verb / harness / channel / record unit tests
npx vitest run src/debug/verbs.serialize.test.ts      # dump/load/step/schema (happy + adversarial)
```
