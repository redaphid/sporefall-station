# Sporefall Station verification map

This directory holds the maintained recipes for proving player-facing behavior of the web build. Read the index, then use the matching feature file.

## Baseline preconditions

- Serve this checkout with `$S/serve.sh start <port>` and require every `$S/doctor.sh <port>` line to be `ok`.
- Never drive a server this run did not start. Doctor fails on someone else's preview.
- Lane A (visual) is the soul-desktop Playwright MCP at `http://localhost:<port>`. Lane B (sim/DOM, no canvas) is `$S/drive.mjs --port <port>`.
- Pass `seed` explicitly so a run is reproducible.

## Driving conventions

- Click buttons by accessible name (`Solo run`, `Start game`) and find overlays by `data-role` (`start-menu`, `state-replay-banner`, `pause-button`).
- Gate on the sim clock (`window.world.tick`), not wall time or load events.
- Read state through `window.sporefall`. Mutate only through `sporefall.verb(...)` under `?debug`, and only to stage.

## Proof and skip reporting

- Record the feature file, entry point, seed, and build number with every artifact.
- A visual claim needs a Lane A still. A Lane B still shows HUD only.
- Report an unreachable path with the command tried and the unmet precondition. Do not report a skipped entry point as verified through another.

## Features

- [Start menu and solo run](./start-menu-solo.md) covers the mode picker, a solo run from it, the `?mode=solo` shortcut, and the autosave. Verified end to end on 2026-09-25.
- [Scenario deep links](./scenario-deep-links.md) covers `?scenario=` staging, deep links beating the saved run, and the unknown-scenario error.
- [Console inspection](./console-inspection.md) covers `window.sporefall` reads everywhere and `verb` writes under `?debug`.
- [Same-machine co-op](./local-coop.md) covers host lobby, join, start, and late join over `?transport=tabs`.
- [State links](./state-links.md) covers `sporefallShare` capture and `?state=<id>` replay.
