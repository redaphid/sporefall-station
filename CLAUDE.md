# CLAUDE.md — working in this repo

Streets of Rogue-ish: a top-down co-op roguelite (Capacitor/Android, TypeScript,
pixi.js) played over Bluetooth LE with no cell service. This file orients an AI
agent working on the codebase. Human-facing setup lives in `README.md`.

## The overarching goal: an AI-native ECS

This engine is deliberately built to be **instrumentable by Claude and by tests**,
not only played by humans. Treat that as a design constraint on new work: prefer
changes that keep the world legible, reproducible, and manipulable by an agent.

The load-bearing property is **determinism**: the sim is a pure function of a
seeded PRNG (forked `mulberry32`) plus a per-tick `InputCmd`. Same seed + same
inputs → byte-identical world, on every device and every replay. Preserve this.

What "AI-native" means here, concretely:

- **Reason about world state.** The world is plain objects (`src/game/world.ts`,
  `src/game/entity.ts`): an `entities` array + `byId` map + rng/tick/floor/mission/
  events. No opaque typed-array SoA — it serializes losslessly to JSON.
- **Set state exactly & replay.** `serializeWorld`/`deserializeWorld`
  (`src/game/serialize.ts`) round-trip the whole world *including the PRNG stream
  position* to/from `WorldJson`. `src/game/testkit.ts` (`loadFixture`, `runTicks`,
  `expectWorldEqual`) builds tests on top: load an exact state → run the real
  systems → assert. Fixtures live in `src/game/__fixtures__/`.
- **Inspect & mutate at runtime.** Under `?debug`, the webview dials out to a
  WebSocket hub (`tools/debug-hub`); a CLI (`tools/debug-cli`) and an MCP server
  (`tools/mcp-debug`, Streamable HTTP) expose verbs — entities/get/set/spawn/kill/
  teleport/state/events, plus world dump/load and tick-step. Implementation and
  verbs: `src/debug/`. Attach procedure: the **`.claude/skills/ecs-debug` skill**
  and `docs/` (a real JS debugger can attach to a headless run via `node --inspect`).
- **Communicate back to the player.** Drawing/labelling on screen and tap-to-inspect
  annotations run on the same substrate, so the agent can show what it reasons about.
- **Reflect on entity types.** Components are ad-hoc optional fields on `Entity`; a
  reflection/schema verb enumerates what's present so an agent can reason about
  unfamiliar entities rather than relying on a hardcoded list.

## Non-negotiables when changing code

- **Determinism.** Never introduce `Date.now()` or `Math.random()` under `src/game/`
  (eslint enforces this). Use the world RNG (`src/game/rng.ts`) and the tick counter
  for anything time- or chance-based. Layout never crosses the wire — levels
  regenerate bit-exact from `seed+floor`.
- **Testing mandate.** Every feature gets strict, exhaustive, **adversarial** TDD
  that (1) sets world state exactly via `deserializeWorld`/`testkit`, (2) runs the
  actual systems (`tickWorld`/`runTicks`) and asserts on the result, and (3) where it
  affects play, produces an **output video** via the `e2e/` recorder (`record()` in
  `e2e/lib.mjs`). Cover adversarial/degenerate inputs, not just the happy path.
- **The layer boundary.** `src/game/` imports no DOM/pixi/net (eslint-enforced). Net
  code sends bit-exact snapshots; the host is authoritative, clients predict + rewind.
- **The debug surface is dev-only** (`?debug`), never enabled in release builds.

## Release / branch workflow

Features are built on `feat/*` branches (often by background subagents in git
worktrees) and **merged into `main`** — `main` is the release; phones pull/run it.
Gate every merge on `npm run build` (typecheck) + `npx vitest run` + `npm run lint`
all green, resolve conflicts (watch for *semantic* conflicts, not just textual),
re-run the full suite after each merge, then `git push origin main`.

## Map of the codebase

| Path | What |
|---|---|
| `src/game/` | Deterministic sim: world, entities, systems, rng, serialize, testkit, fixtures |
| `src/app/` | Session seam: `HostSession` (solo=host, no peers), `NetHostSession`, `NetClientSession` |
| `src/net/` | Transport abstraction (BroadcastChannel dev · BLE host/client), snapshot framing |
| `src/render/` | pixi.js v8 renderer, effects, camera |
| `src/ui/` | HUD, screens/overlays, menus (DOM) |
| `src/input/` | Keyboard, touch/twin-stick, gamepad co-op, scripted (`?script=`) input |
| `src/debug/` | Live debug channel, verbs, record/replay |
| `tools/` | `debug-hub` (WS), `debug-cli`, `mcp-debug` (MCP) |
| `e2e/` | Playwright + ffmpeg deterministic video recorder + scenario assertions |
| `scripts/test/` | Debug/exploratory harness scripts (not unit tests; no `test_` prefix) |

Prefer Context7 MCP for current library docs (Capacitor, pixi.js, playwright, MCP
SDK) rather than relying on memory — these APIs move.
