---
name: gameplay-experiments
description: >-
  Explore Sporefall Station's world in the ECS debugger, compose deterministic scenarios
  (heists, set-pieces, emergent-mechanic tests), narrate them on screen with the
  annotation system, and produce annotated screenshot/video recordings. Use when
  asked to "try out" gameplay ideas, design multi-stage co-op scenarios, discover
  emergent mechanics, or make annotated gameplay reels.
---

# Gameplay experiments

A repeatable loop for **inventing and recording gameplay** using the AI-native ECS.
Everything here is deterministic and serializable, so experiments replay
byte-identically and every claim in a recording can be asserted. Pairs with the
[`ecs-debug`](../ecs-debug/SKILL.md) skill (attach/inspect); this one is about
composing, narrating, and recording scenarios.

## The loop

1. **Explore** what the world can express.
2. **Compose** an exact-state scenario (a `WorldJson` fixture).
3. **Narrate** it with annotations (Claude → player).
4. **Drive & record** it headlessly (video + stills).
5. **Report** findings, gaps, and engine-addition ideas.

## 1. Explore — learn the palette

Read the systems in `src/game/systems/` (missions, doors/locks, alarm/cops,
hacking, stealth/AI + `relationships.ts`, inventory, elements fire/frost/shock)
to learn the verbs of play. Then poke live state with the debug tooling:

- Debug verbs (`src/debug/verbs.ts`, over the hub/CLI/MCP): `entities`, `get`,
  `set`, `spawn`, `kill`, `teleport`, `state`, `events`, `dump`, `load`, `step`,
  `schema` (reflection — enumerate kinds/archetypes/components), `annotate`,
  `clearAnnotations`, `addMod`.
- Sandbox helpers `window.__debug` (from `createDebugApi`, `src/game/debug.ts`,
  exposed under `?e2e`): `noise(x,y)`, `freeze(id)`, `wet(id)`, `shock(id)`,
  `hit(id,dmg?)`. These are the quickest way to trigger element/AI reactions.
- Headless stepping: `pnpm exec tsx scripts/test/inspect-world.ts <world.json> [ticks]`
  (add `--inspect-brk` for a real debugger).

## 2. Compose — an exact-state scenario

Prefer a `WorldJson` fixture so the scene is precise and replayable:

- Start from a seed + `applyScenario(w, name)` (`src/game/scenarios.ts`, also via
  `?scenario=`), or build up with `spawn`/`set`/`teleport`, then capture with
  `serializeWorld(w)` (`src/game/serialize.ts`) into `src/game/__fixtures__/<name>.json`.
- Generate fixtures deterministically in a `scripts/test/gen-*.mts` script (see
  `scripts/test/gen-feature-fixtures.mts`) — fixed seeds, no `Date.now()`/`Math.random()`.
- Load exact state at runtime with `?world=<fixtureName>` (host session only) or,
  for an ad-hoc object, `window.__loadWorld(json)` under `?e2e`.

## 3. Narrate — annotations (Claude → player)

Annotations live in world state (`w.annotations`, inert presentation data) and
render via the overlay. Add them with `addAnnotations(w, raw)`
(`src/game/annotations.ts`), the `annotate` verb, or `window.__annotate(line)`.

Kinds (all accept an optional `text` rendered beside the shape):
- `text` — screen-space banner (e.g. the current stage: "HEIST 1/6 — Case the joint").
- `label` — **entity-anchored, engine-positioned**: `{kind:'label', targetId, text}`
  with no x/y → follows the sprite. Use for roles/targets ("Hacker: cut cameras",
  "VAULT — lockLevel 2", "Guard — posted at vault").
- `pin` — a marker at a point/entity ("LOOT: briefcase").
- `arrow` — `{x,y,x2,y2,text}` for routes ("escape →").
- `circle` — `{x,y,radius,text}` for zones ("danger zone").

Legibility is enforced by `src/ui/annotationLayout.ts` (clamp on-screen, ≤3-line
wrap, off-sprite offset, de-overlap) — keep text short. `ttlTick` auto-expires.

## 4. Drive & record

Reuse the recorder `record(spec)` in `e2e/lib.mjs` (playwright + ffmpeg). It
builds `?<params>`, snaps `stills` at fixed **sim ticks**, records webm→mp4, and
asserts final world state. Compose params: `world=<fixture>` (+ `annotate` baked
into the fixture or pushed via `beforeTicks(page)` using `__annotate`/`__loadWorld`),
`script=<name>` for a deterministic input timeline, `e2e=1`, `class`, `mode=solo`.

```js
await record({
  name: 'heist',
  params: { world: 'heist-stage', script: 'heist', e2e: '1', mode: 'solo', class: 'thief' },
  beforeTicks: async (page) => { /* page.evaluate(() => window.__annotate(...)) per stage */ },
  stills: [{ tick: 30, label: '1-recon' }, { tick: 220, label: '4-vault' }],
  readState: () => ({ vaultOpen: !window.__world.byId.get(VAULT).door.locked }),
  expect: (s) => s.vaultOpen ? [] : ['vault never opened'],
})
```

Assert the scenario actually PROGRESSES (objective fires, alarm trips, cops
arrive) so the recording shows real gameplay, not a pose. Copy final mp4s + PNGs
somewhere retrievable and report exact filenames + sizes.

**Honesty rule:** in a headless run only one local player takes input, so a
multi-player scene's motion *between* scripted beats is teleported/puppeted. Say
so. The *systems* (cloak, sleep-takedown, vault unlock, pickup→mission,
alarm→aggro) are real and asserted; the crew choreography is narration.

## 5. Report

Deliver: the scenario design, the interesting/emergent mechanics found (with
before/after stills), the recordings, **engine gaps** (things the systems can't
yet express), and a **prioritized engine-additions list** (quick wins vs bigger
systems, ranked fun-per-effort). File a GitHub issue capturing it.

## Emergent-mechanic starter catalog (all real, all reproducible)

- **Noise lure** — `__debug.noise(x,y)` makes a guard's goal-arbiter pick
  INVESTIGATE and leave its post. The most heist-relevant behavior.
- **Sleep takedown** — chloroform sets `status.sleep`; sleeping NPCs skip AI.
- **Wet + shock chain** — `__debug.wet(id)` a huddle, `__debug.shock(one)` →
  charge floods every connected wet body.
- **Deep freeze** — `__debug.freeze(id)` immobilizes a guard (can't chase/alarm).

## Constraints

Deterministic (no `Date.now()`/`Math.random()` in `src/game`). Experiments add
fixtures / `scripts/test` / `e2e` scripts / docs — not core-system changes; if a
scenario needs a new mechanic, that's a gap to ticket, not to hack in inline.
Toolchain is **pnpm** on node 25. See `docs/gameplay-experiments.md` for a worked
example.
