# AI inspection from the browser console — `window.world` & `window.sporefall`

Every build of Sporefall Station — dev server, e2e bundle, **and the deployed site** —
exposes the live ECS world to the browser console. This is the AI-native ECS
philosophy (see `CLAUDE.md`) applied to the console: an AI agent driving Chrome
(e.g. the claude-in-chrome MCP, which can run JavaScript in the page and read
the console) can answer *"what is happening in this game right now?"* with no
debug-hub WebSocket infrastructure. Humans get the same surface in DevTools.

At boot the game logs one line so an agent reading the console finds it
immediately:

```
sporefall build 273: window.world + window.sporefall.help() for inspection
```

Implementation: `src/app/inspect.ts` (wired in `src/main.ts`); verbs are the
existing dispatcher in `src/debug/verbs.ts`.

## The two entry points

- **`window.world`** — a **live reference** to the current `World` (see
  `src/game/world.ts`): plain serializable objects — `entities`, `byId`, `tick`,
  `floor`, `mission`, `alarm`, `rng`, … On a solo/host session it is the
  authoritative world; on a join (client) session it is the latest predicted
  view, flagged `{predicted: true}`. Look, don't touch — mutate only through
  `sporefall.verb()` (dev-gated, below).
- **`window.sporefall`** — the curated, stable inspection namespace. Every
  method **except `.world` returns detached JSON clones**, so nothing you do to
  a returned object can ever touch the sim. The namespace object is frozen.

## The API (`sporefall.help()` prints this in-page)

| Call | Returns |
|---|---|
| `sporefall.world` | the same live world as `window.world` |
| `sporefall.help()` | compact self-describing usage doc |
| `sporefall.tick()` | current sim tick |
| `sporefall.session()` | `{mode, paused, floor, tick, gameOver, seed?, difficulty?, alarm?, peers?}` |
| `sporefall.version()` | running build number |
| `sporefall.entities(filter?)` | matching entities as JSON clones |
| `sporefall.entity(id)` | one entity clone (or `undefined`) |
| `sporefall.player(playerId?)` | the local player entity (or player *N*) |
| `sporefall.mission()` | `{template?, description, complete, targetEntityId?, …}` |
| `sporefall.events(sinceTick?)` | recent sim events tagged `{tick, type, …}` |
| `sporefall.schema()` | live component/archetype reflection |
| `sporefall.serialize()` | lossless `WorldJson` string |
| `sporefall.verb(line, args?)` | debug verb dispatcher — **dev-gated** |

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
repo non-negotiable): `sporefall.verb()` only executes when the page was loaded
with `?debug` (or `?e2e`). In production it *exists* — discoverability without
capability — and returns a refusal string explaining the gate:

```js
sporefall.verb('teleport 12 5 5')
// → "sporefall.verb is disabled in this build: mutation verbs are dev-only.
//    Reload with ?debug in the URL to enable them. …"
```

Under `?debug` the whole verb surface of `src/debug/verbs.ts` is live —
`get/set/spawn/kill/teleport/step/dump/load/annotate/ai/behaviors/setBehavior/
addMod/theme/schema/state/events` — the exact same dispatcher the debug hub,
CLI, and MCP server drive:

```js
sporefall.verb('spawn npc guard 10 12')
sporefall.verb('teleport', `${sporefall.player().id} 5 5`)   // (line, args) form
sporefall.verb('step 30')                                    // advance 30 neutral ticks
sporefall.verb('annotate {"type":"label","x":10,"y":12,"text":"watch this guard"}')
```

## Recipes for common questions

**"What's the state of the game right now?"**

```js
sporefall.session()          // mode/floor/tick/paused/gameOver
sporefall.mission()          // objective + completion
sporefall.schema().kinds     // what's on the map, by count
```

**"Why did that NPC attack?"**

```js
const npc = sporefall.entities('npc').find(e => e.ai?.mode === 'combat')
npc.ai                                  // behavior, target, faction, home, …
sporefall.events(sporefall.tick() - 300)  // recent aiGoal/alerted/hit/noise events
// under ?debug, the full reasoned dump:
sporefall.verb(`ai ${npc.id}`)           // considerations + last think's scores
```

**"Who's about to die?"**

```js
sporefall.entities('e => e.health && e.health.hp <= 1')
```

**"Save this exact moment so a test can replay it."**

```js
copy(sporefall.serialize())   // WorldJson — byte-identical restore via
                             // ?world= / the load verb / deserializeWorld
```

**"Did the mission target despawn?"**

```js
sporefall.entity(sporefall.mission().targetEntityId)   // undefined = gone
```

## Relationship to the other debug surfaces

- The `?debug` **WebSocket hub** (`tools/debug-hub`, `.claude/skills/ecs-debug`)
  drives the same verbs from *outside* the browser (CLI/MCP). Use `sporefall`
  when you are already *in* the browser (claude-in-chrome, DevTools) or when
  pointed at the deployed site where no hub exists.
- The legacy `?e2e` hooks (`window.__world`, `window.__verb`, `window.__annotate`)
  are now thin aliases over this namespace — same world reference, same
  dispatcher — kept so existing e2e suites keep working. New code should use
  `window.sporefall`.

Tests: `src/app/inspect.test.ts` (unit: filters, ring buffer, gating, help
completeness) and `e2e/ai-inspection.mjs` via `pnpm run e2e:ai-inspect`
(drives the real page through the surface with and without `?debug`).
