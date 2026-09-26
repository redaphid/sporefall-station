# Scenario deep links

A link such as `/?mode=solo&seed=18&scenario=armed&floor=3` drops the player straight into a staged situation. A deep link always wins over the saved run and never overwrites it. An unknown scenario shows a visible error instead of silently starting a normal run.

## Sub-features

- `stage`: a named scenario from `src/game/scenarios.ts` (`armed`, `stairs-demo`, `fire`, `frost`, `doors`, `npc-combat`, and the group scenarios `tide-staging`, `tide-siege`, `tide-medic`, `tide-sappers`, `hound-ring`, `hive-spread`) stages its scene.
- `wins`: the link starts the scenario even when a save exists, and the save is unchanged afterwards.
- `unknown`: `?scenario=nope` shows `[data-role=boot-error]`, starts no run, and leaves the save alone.

## How to get to it (user POV)

- Open a shared URL carrying `scenario=` (and optionally `floor=`, `seed=`).

## Driving it with drive.mjs

Preconditions: doctor green. For `wins`, create a save first in the same context.

- **Stage (Lane B).** `--open '/?mode=solo&seed=18&scenario=armed&floor=3' --until-tick 30 --assert "sporefall.session().floor === 3"`. Then `--eval "sporefall.player().combat.weapon"` and expect the machine gun loadout.
- **Wins over the save (Lane B).** `--open '/?mode=solo' --until-tick 60 --eval "sporefall.session().seed" --reload '/?mode=solo&seed=18&scenario=armed&floor=3' --until-tick 30`. Assert floor 3, then assert `JSON.parse(localStorage.getItem('sporefall.savegame')).world.seed` equals the recorded seed. The first run takes no `seed=`, because a seeded run is never saved. The save envelope may be the world itself; see `e2e/deep-link-wins.mjs`.
- **Unknown (Lane B).** `--reload '/?mode=solo&scenario=nope' --until "document.querySelector('[data-role=boot-error]')" --shot unknown-scenario`.
- **Look of a scene (Lane A).** Navigate to the same URL and screenshot after the beat named in the scenario's comment in `src/game/scenarios.ts`.

Suite that covers this: `pnpm run test:e2e:deep-link`. Not yet driven through this skill.

## Gotchas

- The save envelope shape changed over time. Read both `env.world.seed` and `env.seed`.
- Group scenarios land their beat after a delay. Read the stage function for the tick to wait for.
