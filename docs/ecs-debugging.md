# AI-native ECS debugging

How CLAUDE (and tests) attach to the running engine, inspect runtime state,
mutate it, snapshot/restore an exact world, single-step the sim, and reason
about unfamiliar entities. This EXTENDS the debug harness in
[`ecs-debug-harness.md`](./ecs-debug-harness.md) — same hub, same verb grammar,
same ports. Read that first for the transport picture; this page is the
inspection/mutation contract layered on top.

The repeatable, copy-paste procedure lives in the
[`ecs-debug` skill](../.claude/skills/ecs-debug/SKILL.md). This document is the
reference behind it.

## The debug surface at a glance

```
  game (webview, ?debug)  ──►  hub (laptop :7810)  ◄──  debuggers (CLI / MCP :7811)
        outbound WS              relay + fan-out           outbound WS
```

- **Dev-only / opt-in.** The in-app channel (`src/debug/channel.ts`) is a no-op
  and is not even bundled unless the app is opened with `?debug` — it is a
  dynamic import gated in `src/main.ts`. It never ships in a release build.
- Every client (CLI, MCP, in-app) speaks one **verb line** of text. Reads answer
  immediately; writes are deferred onto a sim-safe point between tick and render.
- `runVerb(world, line)` in `src/debug/verbs.ts` is the single bridge — pure,
  synchronous, transport-agnostic, and unit-tested.

## Verb reference (live world — `runVerb`)

| Verb | Reads/Writes | Does |
|---|---|---|
| `entities` | read | every entity: id/kind/archetype + **verbatim** component JSON (unknown/future components included automatically) |
| `get <id>` | read | one entity's verbatim JSON |
| `state` | read | tick, seed, floor, alarm, gameOver, mission, per-kind counts |
| `events` | read | recent sim events (bounded ring) |
| `schema` | read | **reflection**: the live component/archetype shape of the world (see below) |
| `dump` | read | **lossless WorldJson snapshot** of the WHOLE world (`serializeWorld`) |
| `set <id> <jsonPatch>` | write | deep-merge a JSON patch, coercing scalars to the field's existing type |
| `spawn <kind> <archetype> <x> <y>` | write | npc→fully wired, player→wired, else a bare entity |
| `kill <id>` | write | kill (players are downed, not removed) |
| `teleport <id> <x> <y>` | write | move + clear interpolation |
| `load <WorldJson>` | write | **restore an EXACT world** from a `dump` snapshot, in place (`deserializeWorld`) |
| `step [n]` / `tick [n]` | write | advance the sim `n` deterministic ticks with neutral input (default 1) |
| `command <verb …>` | — | escape hatch: run a raw verb line verbatim |

Payloads with spaces/newlines can be wrapped `b64:<base64>` on the wire
(`encodeArg`/`decodeArg`); the WebSocket transport also carries a full JSON line
verbatim, so a whole `dump`ed world can be fed straight back to `load`.

> The headless **GameHarness** (`runHarnessVerb`) adds session/lobby/record verbs
> and keeps its OWN `save`/`load`/`tick` (record.ts `WorldFixture` scenario
> fixtures). The `dump`/`step`/`schema` verbs fall through to the world surface
> there too. On the in-app live channel, `load`/`tick` mean the WorldJson /
> neutral-step semantics above. See `ecs-debug-harness.md` for the harness verbs.

## The serialize / replay contract (`dump` ↔ `load`)

`dump` returns a versioned **`WorldJson`** (`src/game/serialize.ts`, #47): every
entity verbatim, the mission/alarm/tick/nextId scalars, pending events, and — the
keystone — the **RNG stream position** of both the run PRNG and the per-floor sim
fork. The level itself is NOT stored; it is regenerated from `seed`+`floor` on
load and validated by a `levelChecksum` (a mismatch throws instead of silently
restoring a wrong map).

`load` rebuilds a fresh, standalone world from that JSON and swaps it into the
live world **in place**, so the channel's reference keeps pointing at the same
object. Because the RNG position is restored, the loaded world is
**byte-identical on every subsequent tick** to the world it was captured from,
given the same per-tick inputs. This is the round-trip guarantee the tests pin:

```
dump(w) → load → expectWorldEqual(loaded, w)          // exact snapshot equality
load(snapshot); step N   ==   original; tickWorld×N    // byte-identical replay
```

Use it to **set world state EXACTLY** before an experiment: `dump` a scenario
once, then `load` it to reset to that precise state as many times as you like.

## Determinism guarantees

The sim is a **pure function of `(seed → forked RNG)` + the per-tick `InputCmd`
map**. There is no other entropy:

- **No wall-clock, no ad-hoc randomness in `src/game`.** `Date`, `Date.now()`,
  and `Math.random()` are eslint-forbidden there (`eslint.config.js`
  `no-restricted-globals` / `no-restricted-properties`); all randomness draws from
  the seeded `Rng` in `src/game/rng.ts`.
- `tickWorld(world, inputs)` advances exactly one step; the `step` verb feeds a
  **neutral** (empty) input map, so a stepped world is reproducible from its
  snapshot.
- Entities are plain data, so a verbatim JSON clone captures every field —
  including components no debug tool knows about yet.

Because inputs are the only entropy, `dump`→`load`→`step` and record→`replay`
both reproduce the same entities and events bit-for-bit.

## Reflection — the `schema` verb

`schema` enumerates the world's shape **from its live entities**, so unfamiliar
or newly-added components are discovered dynamically (nothing is hardcoded to
rot). It returns:

```jsonc
{
  "entityCount": 4,
  "kinds":      { "npc": 3, "player": 1 },
  "archetypes": { "cop": { "kind": "npc", "count": 2 }, "player": { "kind": "player", "count": 1 }, ... },
  "fields": {
    "pos":       { "count": 4, "types": ["object"], "keys": ["x","y"] },
    "health":    { "count": 4, "types": ["object"], "keys": ["hp","iframes","max"] },
    "ai":        { "count": 3, "types": ["object"], "keys": ["faction","goal","home","mode","sightRange","thinkAt","waypoint"] },
    "playerCtl": { "count": 1, "types": ["object"], "keys": ["abilityCooldown","activeSlot","cash","classId",...] },
    "futureThing": { "count": 1, "types": ["object"], "keys": ["tags","z"] }   // a component no tool knew about — enumerated anyway
  }
}
```

- `kinds` / `archetypes` — population by `EntityKind` and by `archetype`.
- `fields` — for every top-level entity field seen: how many entities carry it,
  its JSON types, and (for object components) the union of nested sub-keys.

Reason about a strange entity by cross-referencing `schema` (what components
exist and their shape) with `get <id>` (this entity's actual values).

## Attaching a real JS debugger (`--inspect`)

`scripts/test/inspect-world.ts` is a headless, render/net-free entry point that
loads a `WorldJson` (or bootstraps a fresh world) and runs the pure sim — a clean
place to set breakpoints in `src/game/**`.

Run it:

```sh
pnpm exec tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
pnpm exec tsx scripts/test/inspect-world.ts --new 20260715 1 30      # fresh seed/floor, 30 ticks
```

Debug it under Chrome DevTools / VS Code (breakpoints, step, inspect `world`):

```sh
node --inspect-brk --import tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
```

Then open `chrome://inspect` and click **inspect**. Execution pauses at the
`debugger` line with `world` already loaded; set breakpoints in `src/game/**`
(a system, the RNG, serialize) and resume — each `tickWorld` runs the whole sim
step under the debugger. Capture a live world to a file first with
`pnpm exec tsx tools/debug-cli/cli.ts dump > world.json`, then feed `world.json` in.

## Verify

```sh
pnpm exec vitest run src/debug/                # verb / harness / record / channel unit tests
pnpm exec vitest run src/debug/verbs.serialize.test.ts   # the #49 dump/load/step/schema tests
pnpm exec tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
```
