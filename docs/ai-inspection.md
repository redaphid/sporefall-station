# AI inspection from the browser console — `window.world` & `window.backseat`

Every build of Backseat — dev server, e2e bundle, **and the deployed site** —
exposes the live ECS world to the browser console. This is the AI-native ECS
philosophy (see `CLAUDE.md`) applied to the console: an AI agent driving Chrome
(e.g. the claude-in-chrome MCP, which can run JavaScript in the page and read
the console) can answer *"what is happening in this game right now?"* with no
debug-hub WebSocket infrastructure. Humans get the same surface in DevTools.

At boot the game logs one line so an agent reading the console finds it
immediately:

```
backseat build 273: window.world + window.backseat.help() for inspection
```

Implementation: `src/app/inspect.ts` (wired in `src/main.ts`); verbs are the
existing dispatcher in `src/debug/verbs.ts`.

## The two entry points

- **`window.world`** — a **live reference** to the current `World` (see
  `src/game/world.ts`): plain serializable objects — `entities`, `byId`, `tick`,
  `floor`, `mission`, `alarm`, `rng`, … On a solo/host session it is the
  authoritative world; on a join (client) session it is the latest predicted
  view, flagged `{predicted: true}`. Look, don't touch — mutate only through
  `backseat.verb()` (dev-gated, below).
- **`window.backseat`** — the curated, stable inspection namespace. Every
  method **except `.world` returns detached JSON clones**, so nothing you do to
  a returned object can ever touch the sim. The namespace object is frozen.

## The API (`backseat.help()` prints this in-page)

| Call | Returns |
|---|---|
| `backseat.world` | the same live world as `window.world` |
| `backseat.help()` | compact self-describing usage doc |
| `backseat.tick()` | current sim tick |
| `backseat.session()` | `{mode, paused, floor, tick, gameOver, seed?, difficulty?, alarm?, peers?}` |
| `backseat.version()` | running build number |
| `backseat.entities(filter?)` | matching entities as JSON clones |
| `backseat.entity(id)` | one entity clone (or `undefined`) |
| `backseat.player(playerId?)` | the local player entity (or player *N*) |
| `backseat.mission()` | `{template?, description, complete, targetEntityId?, …}` |
| `backseat.events(sinceTick?)` | recent sim events tagged `{tick, type, …}` |
| `backseat.schema()` | live component/archetype reflection |
| `backseat.serialize()` | lossless `WorldJson` string |
| `backseat.verb(line, args?)` | debug verb dispatcher — **dev-gated** |

`entities(filter)` accepts:

- nothing — every entity;
- a **name** — matches kind (`'npc'`), archetype (`'guard'`), or component
  presence (`'door'`, `'playerCtl'`, `'ai'`);
- a **predicate string** — compiled in-page: `'e => e.health?.hp < 3'`;
- a real function, if you're typing in DevTools anyway.

`events()` is a ring buffer the frame loop maintains: `world.events` is wiped
every tick, so the surface keeps the last ~600 ticks' worth (~20 s, capped at
2048 events), each tagged with the tick it happened on.

## Read-only vs `?debug` writes

Reads work everywhere, including production. **Mutation stays dev-only** (a
repo non-negotiable): `backseat.verb()` only executes when the page was loaded
with `?debug` (or `?e2e`). In production it *exists* — discoverability without
capability — and returns a refusal string explaining the gate:

```js
backseat.verb('teleport 12 5 5')
// → "backseat.verb is disabled in this build: mutation verbs are dev-only.
//    Reload with ?debug in the URL to enable them. …"
```

Under `?debug` the whole verb surface of `src/debug/verbs.ts` is live —
`get/set/spawn/kill/teleport/step/dump/load/annotate/ai/behaviors/setBehavior/
addMod/theme/schema/state/events` — the exact same dispatcher the debug hub,
CLI, and MCP server drive:

```js
backseat.verb('spawn npc guard 10 12')
backseat.verb('teleport', `${backseat.player().id} 5 5`)   // (line, args) form
backseat.verb('step 30')                                    // advance 30 neutral ticks
backseat.verb('annotate {"type":"label","x":10,"y":12,"text":"watch this guard"}')
```

## Recipes for common questions

**"What's the state of the game right now?"**

```js
backseat.session()          // mode/floor/tick/paused/gameOver
backseat.mission()          // objective + completion
backseat.schema().kinds     // what's on the map, by count
```

**"Why did that NPC attack?"**

```js
const npc = backseat.entities('npc').find(e => e.ai?.mode === 'combat')
npc.ai                                  // behavior, target, faction, home, …
backseat.events(backseat.tick() - 300)  // recent aiGoal/alerted/hit/noise events
// under ?debug, the full reasoned dump:
backseat.verb(`ai ${npc.id}`)           // considerations + last think's scores
```

**"Who's about to die?"**

```js
backseat.entities('e => e.health && e.health.hp <= 1')
```

**"Save this exact moment so a test can replay it."**

```js
copy(backseat.serialize())   // WorldJson — byte-identical restore via
                             // ?world= / the load verb / deserializeWorld
```

**"Did the mission target despawn?"**

```js
backseat.entity(backseat.mission().targetEntityId)   // undefined = gone
```

## Relationship to the other debug surfaces

- The `?debug` **WebSocket hub** (`tools/debug-hub`, `.claude/skills/ecs-debug`)
  drives the same verbs from *outside* the browser (CLI/MCP). Use `backseat`
  when you are already *in* the browser (claude-in-chrome, DevTools) or when
  pointed at the deployed site where no hub exists.
- The legacy `?e2e` hooks (`window.__world`, `window.__verb`, `window.__annotate`)
  are now thin aliases over this namespace — same world reference, same
  dispatcher — kept so existing e2e suites keep working. New code should use
  `window.backseat`.

Tests: `src/app/inspect.test.ts` (unit: filters, ring buffer, gating, help
completeness) and `e2e/ai-inspection.mjs` via `pnpm run e2e:ai-inspect`
(drives the real page through the surface with and without `?debug`).
