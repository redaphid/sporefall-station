# Gameplay experiments — worked guide

How to invent, narrate, and record gameplay in Sporefall Station using the AI-native ECS.
This is the long-form companion to the [`gameplay-experiments`](../.claude/skills/gameplay-experiments/SKILL.md)
skill. The whole point: because the sim is a pure function of a seeded PRNG plus
per-tick input, any scenario you build is **exactly reproducible** — so a recording
is also a test, and Claude can compose, narrate, and verify a scene end-to-end.

## Why this exists

The heist experiment (issue #55) showed the engine can already express
**planned, interdependent co-op play** (cloak → sleep-takedown → hack the vault →
grab loot → alarmed getaway) and surprising **emergent mechanics** (noise lures,
wet+shock chains, deep-freeze crowd control) — all driven purely from the debug
and annotation surface, with no core-system changes. This guide captures that loop
so the next experiment starts from a recipe.

## The toolbox (what's on `main`)

| Capability | Where | Notes |
|---|---|---|
| Inspect/mutate live state | `src/debug/verbs.ts` verbs: `entities`/`get`/`set`/`spawn`/`kill`/`teleport`/`state`/`events`/`dump`/`load`/`step`/`schema`/`annotate`/`clearAnnotations`/`addMod` | over the hub / CLI / MCP |
| Reflection | `schema` verb | enumerate kinds/archetypes/component fields dynamically |
| Sandbox reactions | `window.__debug` (`src/game/debug.ts`, under `?e2e`) | `noise(x,y)`, `freeze(id)`, `wet(id)`, `shock(id)`, `hit(id,dmg?)` |
| Exact state | `serializeWorld`/`deserializeWorld` (`src/game/serialize.ts`), `testkit.ts` | lossless `WorldJson`, byte-identical replay |
| Scenario presets | `applyScenario(w, name)` (`src/game/scenarios.ts`), `?scenario=` | clears the random crowd, then stages a scene |
| Load exact world at runtime | `?world=<fixture>` or `window.__loadWorld(json)` (`?e2e`) | host session only |
| Annotations (draw) | `addAnnotations(w, raw)` / `annotate` verb / `window.__annotate(line)` (`src/game/annotations.ts`) | renders via `src/ui/overlay.ts` |
| Selection (point) | `Entity.selected` + tap-inspect (`src/ui/inspectModel.ts`) | user picks; Claude reads via `entities`/`get` |
| Record | `record(spec)` (`e2e/lib.mjs`, playwright + ffmpeg) | stills at fixed sim ticks + webm→mp4 + state asserts |
| Headless step/debug | `scripts/test/inspect-world.ts` | `pnpm exec tsx scripts/test/inspect-world.ts <world.json> [ticks]` |

## Annotation vocabulary

Annotations are inert world data (`w.annotations`) that the overlay renders; any
kind can carry a `text` label placed beside it by the engine (legibility enforced
by `src/ui/annotationLayout.ts`).

- `text` — screen banner: the current stage / instruction.
- `label` — entity-anchored (`targetId`, no x/y): roles and targets that follow sprites.
- `pin` — a marked point/entity.
- `arrow` — `{x,y,x2,y2,text}`: routes, "escape →".
- `circle` — `{x,y,radius,text}`: danger/objective zones.

Keep text short; set `ttlTick` for transient callouts. This same vocabulary is
enough to **coach a plan on screen** (annotation-driven tutorials) or to run an
**AI director** that reads world state and injects annotated complications live.

## Worked example: a narrated multi-stage scene

1. **Design** the stages and role dependencies (each stage gated on the last).
2. **Build a fixture:** seed a world, `applyScenario`/`spawn`/`set`/`teleport` the
   guards, vault (`door.locked`, `lockLevel`), loot (briefcase), and crew, then
   `serializeWorld` → `src/game/__fixtures__/<name>.json` from a
   `scripts/test/gen-*.mts` generator (fixed seed).
3. **Script inputs** (`src/input/scripted.ts`, `?script=`) for the beats you want
   the live player to perform; use `step`/`__debug` for the rest.
4. **Narrate:** per stage, push annotations (`window.__annotate` in `beforeTicks`,
   or bake into the fixture) — a `text` banner for the stage, `label`s on roles and
   targets, an `arrow` for the exit, a `circle` for danger.
5. **Record & assert:**

```js
import { record } from './lib.mjs'
await record({
  name: 'heist',
  params: { world: 'heist-stage', script: 'heist', e2e: '1', mode: 'solo' },
  beforeTicks: async (page) => {
    await page.evaluate(() => {
      window.__annotate('text "HEIST 1/6 — Case the joint"')
      window.__annotate('label target=VAULT_ID "VAULT — lockLevel 2"')
      window.__annotate('pin target=LOOT_ID "LOOT: briefcase"')
    })
  },
  stills: [
    { tick: 30,  label: '1-recon' },
    { tick: 220, label: '4-vault' },
    { tick: 400, label: '5-loot' },
    { tick: 700, label: '7-getaway' },
  ],
  readState: () => ({
    vaultOpen: !window.__world.byId.get(VAULT_ID).door.locked,
    stolen: window.__world.mission.complete,
  }),
  expect: (s) => [
    ...(s.vaultOpen ? [] : ['vault never opened']),
    ...(s.stolen ? [] : ['briefcase never stolen']),
  ],
})
```

Run it: `pnpm exec node e2e/<your-script>.mjs` after `pnpm run build` + serving
`dist` (see `e2e/run.sh` for the preview-server pattern). Copy the mp4 + PNGs to a
retrievable dir and report filenames + sizes.

## The honesty rule (read this)

In a headless run only **one** local player provides input. So in a staged
multi-player scene, the crew's motion *between* scripted beats is teleported —
it's narration, a puppet. Always say which parts are real. The **systems** —
cloak halving sight, chloroform `status.sleep`, the hacker beating a lockLevel the
thief's autopick can't, pickup→`missionSystem`, crime→alarm→LOS cop chase — are
genuine and asserted. Single-mechanic reels (noise lure, wet+shock, freeze) are
fully real system behavior.

## Emergent mechanics found so far

- **Noise lure** — `__debug.noise(x,y)` → a guard's goal-arbiter picks INVESTIGATE
  and walks off post.
- **Sleep takedown** — chloroform → `status.sleep`; sleeping NPCs skip AI.
- **Wet + shock chain** — soak a huddle (`wet`), zap one (`shock`) → charge floods
  every connected wet body.
- **Deep freeze** — `freeze(id)` immobilizes a guard (no chase, no alarm).

Add to this catalog as you discover more.

## Known engine gaps (ticket, don't hack inline)

- No camera/sensor entities ("cut the cameras" has no in-engine referent yet).
- Alarm is a bare 0–3 scalar — theft doesn't trip it; no reinforcements.
- No driven patrol routes / suspicion ramp / reaction to bodies or open vaults.

See issue #55 for the full prioritized engine-additions list (quick wins:
escalating alarm, patrol routes, camera entity, noise item, objective flags,
disguise; bigger: a real stealth/detection + guard-AI system, an alarm/heat
director, an objective DAG; AI-native: an AI director + annotation tutorials).
