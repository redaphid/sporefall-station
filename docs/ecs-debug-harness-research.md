# ECS debug harness — research & design notes

Findings behind the live ECS debug harness (issue #29): what the field does for
debugging entity-component-system worlds, what our sibling C# harness proved in
production, and how both shaped this design.

## 1. ECS debugging best practices (web)

Surveying the mature ECS tooling (Unity Entities' **Entity Debugger**, Meta
Horizon's **Data Model Inspector**, Leopotam's `ecs-unityintegration`) the same
handful of patterns recur:

- **Entity browser + component inspector.** The primary surface is "list every
  entity, select one, see all its components, edit a field live." Unity's Entity
  Debugger and Meta's DMI both center on this. → our `entities` / `get` /
  `set` verbs.
- **Live mutation through real choke points.** Editing a component value at
  runtime and letting the systems react is the fastest way to reproduce and
  probe a bug — far faster than editing code and rebuilding. → `set`, `spawn`,
  `kill`, `teleport` mutate the same world the systems run against.
- **System toggling / stepping.** Unity lets you disable individual systems and
  see per-system frame cost. We don't need per-system toggles yet, but the same
  spirit — mutate between ticks, never mid-system — drove our deferred-write
  model.
- **Snapshot / time-travel & diffing.** Heavier ECS tools snapshot the world and
  diff snapshots to localize divergence. We don't ship time-travel, but the
  `state` summary (tick/seed/counts) plus a serialized entity mirror are the
  primitives you'd build it from, and the event stream is the change log.
- **Event streaming.** A long-lived stream of "what just happened" (deaths,
  hits, pickups) grounds debugging in real behavior instead of polled guesses.
  → the pushed `events` stream.
- **A query/verb language + an escape hatch.** Rather than a bespoke RPC per
  need, expose a small verb grammar and one raw pass-through so new needs don't
  need new plumbing. → single `runVerb` bridge + the `command` escape hatch.

Sources: Unity Entities "Debugging ECS"
(https://docs.unity3d.com/Packages/com.unity.entities@0.51/manual/ecs_debugging.html),
Meta Horizon OS ECS
(https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-ecs/),
Leopotam ecs-unityintegration
(https://github.com/Leopotam/ecs-unityintegration).

## 2. The proven sibling pattern (C# harness)

`multiplayer/docs/debug-harness.md` + `gm/src` are a shipping version of exactly
this idea over a different transport. The load-bearing patterns we replicated:

- **A single `raw(verb)` bridge.** Every MCP tool in `gm/src/mcp/server.ts` is a
  one-liner delegating to `host.raw(...)`/one host method; the game exposes one
  command channel. We mirror this precisely: every MCP tool → `raw(verb)` →
  hub → `runVerb`. One grammar, one code path, trivially extensible.
- **A verbatim serialized entity mirror.** The C# client keeps `EcsWorld.Raw` —
  the raw component JSON as received — so *unknown/future components are visible
  before any typed class exists for them*. In TS this is even simpler: entities
  are plain data, so `JSON.parse(JSON.stringify(entity))` captures every field,
  including components no verb knows about. `serializeEntity` is that mirror;
  `entities`/`get` return it. (Unit-tested: a hand-injected `futureThing`
  component shows up in the dump.)
- **A long-lived NDJSON-style events stream.** `gm/src/transport.ts` streams
  newline-delimited JSON event frames and reconnects forever. We keep the
  one-event-per-line spirit but ride it over the same WebSocket as verbs (frames
  are `{t:'event', body}`), with a bounded recent-events ring the `events` verb
  can also pull.
- **Base64 for whitespace payloads.** The C# line-oriented channel forbids
  spaces in JSON args; the harness base64-wraps them. We keep the verb grammar
  line-safe the same way: any argument with whitespace is sent as `b64:<...>`
  (`encodeArg`/`decodeArg`), even though WebSocket framing wouldn't strictly
  require it — it keeps the `command` escape hatch and the verb line honest.
- **Main-thread marshaling.** The C# side marshals mutations onto the game's main
  thread so they never tear a frame. Our webview is single-threaded, but we
  still defer writes (`set`/`spawn`/`kill`/`teleport`) into a queue drained at a
  safe point between the sim tick and render — reads answer immediately.

## 3. MCP transport (Context7 → `@modelcontextprotocol/sdk`)

Per project convention and confirmed against the current SDK docs, the MCP
server uses the **Streamable HTTP** transport, **never SSE**. Key facts applied:

- `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` = stateless
  mode: no session id, each POST is independent. With `enableJsonResponse: true`
  a single POST returns a single JSON-RPC response (no streaming needed for our
  request/response tools). Same shape the sibling `gm` server uses in prod.
- Tools are registered with `server.registerTool(name, { description,
  inputSchema }, handler)` where `inputSchema` is a Zod **raw shape** (`{ x:
  z.number() }`), validated by the SDK. We pin `zod@^4` + `@modelcontextprotocol/sdk@^1.29`
  to match the known-good sibling combo.

## 4. How the research shaped the build

| Best practice | Where it lives |
|---|---|
| Entity browser / inspector | `entities`, `get` verbs (`src/debug/verbs.ts`) |
| Live mutation | `set` (deep-merge + coerce), `spawn`, `kill`, `teleport` |
| Verbatim mirror (future-proof) | `serializeEntity` — full JSON clone |
| Event streaming | pushed `{t:'event'}` frames + `events` verb + recent ring |
| Single bridge + escape hatch | one `runVerb`; `command` passthrough; every MCP tool → `raw(verb)` |
| Line-safe payloads | `b64:` wrapping via `encodeArg`/`decodeArg` |
| No mid-frame tearing | writes deferred to `afterTick`, reads immediate |
| Outbound-only from phone | webview dials the hub; hub relays to debuggers |
