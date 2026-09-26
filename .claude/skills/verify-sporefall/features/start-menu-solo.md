# Start menu and solo run

A player opens the game, sees the mode picker with the build number and release notes, taps Solo run, and lands on floor 1 with a mission. The run autosaves. Reopening the site shows the picker again, and Solo run then continues the saved run at the tick it left off.

## Sub-features

- `menu`: the picker shows Solo run, Host co-op, Join co-op, Settings, the build number, and release notes.
- `solo`: Solo run starts floor 1 with a live player and a mission.
- `shortcut`: `?mode=solo` skips the picker.
- `autosave`: a run writes `localStorage['sporefall.savegame']`. After a reload of `/`, Solo run continues it (same seed, next tick).

## How to get to it (user POV)

- Open the site root. The picker appears.
- Open a link with `?mode=solo`. The run starts directly.

## Driving it with drive.mjs and the soul-desktop MCP

Preconditions: doctor green on `<port>`.

- **Menu and solo (Lane B).** Run the SKILL.md example (`--open '/?seed=7'` … `--click 'Solo run'`). Expect `sporefall.session()` to be `{mode:'solo', seed:7, floor:1}`, player hp above 0, and a non-empty `sporefall.mission().description`.
- **Autosave (Lane B).** Add `--assert "!!localStorage.getItem('sporefall.savegame')"` after `--until-tick 90`, and `--eval "sporefall.tick()"`. Then add `--reload '/'` `--until "document.querySelector('[data-role=start-menu]')"` `--click 'Solo run'` `--until "window.world"` `--assert "sporefall.session().seed === 7"`. The resumed tick is the saved tick plus about one, not 0.
- **Rendered world (Lane A).** `browser_navigate` to `http://localhost:<port>/?mode=solo&seed=7`, wait until `window.world.tick > 60`, and screenshot. Expect tiles, the player sprite, the HUD, and the mission pill.

Last proven 2026-09-25 at build 564+. Lane B passed in `e2e/output/verify/2026-09-26T00-26-48-475Z-start-menu-solo/`: floor 1, 28 NPCs, the mission "Extract the specimen canister from the med-bay", the save written at tick 103, and a resume through the picker at tick 111. Lane A rendered through ANGLE on the RTX 4090; its still is `lane-a-rendered.png` in the same directory.

## Gotchas

- The picker blocks DOMContentLoaded (see SKILL.md). Gate on `[data-role=start-menu]`.
- A Lane A profile may already hold a save. Solo run from the picker then resumes it instead of starting fresh, and `?mode=solo&seed=N` with a matching seed resumes it too. Remove `sporefall.savegame` from localStorage first.
