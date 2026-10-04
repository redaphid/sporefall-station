# Scenario deep links

A link such as `/?mode=solo&seed=18&scenario=armed&floor=3` drops the player straight into a staged situation. A deep link always wins over the saved run and never overwrites it. An unknown scenario shows a visible error instead of silently starting a normal run.

## Sub-features

- `stage`: a named scenario from `SCENARIO_NAMES` in `src/game/scenarios.ts` (`armed`, `fire`, `doors`, the group scenarios `tide-siege` and `hound-ring`, and the rest of the list) stages its scene. The `unknown` error screen prints the full list this build knows.
- `wins`: the link starts the scenario even when a save exists, and the save is unchanged afterwards.
- `unknown`: `?scenario=nope` shows `[data-role=boot-error]`, starts no run, and leaves the save alone.

## How to get to it (user POV)

- Open a shared URL carrying `scenario=` (and optionally `floor=`, `seed=`).

## Driving it with drive.mjs

Preconditions: doctor green. `wins` needs a save first, made in the same context.

One run covers `stage`, `wins`, and `unknown` (`SAVE` reads the stored seed, floor, and tick):

```sh
SAVE="(()=>{const r=localStorage.getItem('sporefall.savegame'); if(!r) return null; const e=JSON.parse(r); const w=e.world??e; return {seed:w.seed,floor:w.floor,tick:w.tick}})()"
$S/drive.mjs --port 4990 --name scenario-deep-links --video \
  --open '/?mode=solo' --until-tick 90 \
  --assert "!!localStorage.getItem('sporefall.savegame')" --eval "$SAVE" --shot save-run \
  --reload '/?mode=solo&seed=18&scenario=armed&floor=3' --until "sporefall.session().seed === 18 && sporefall.tick() >= 30" \
  --assert "sporefall.session().floor === 3" \
  --eval "({weapon: sporefall.player().combat.weapon, hp: sporefall.player().health})" \
  --eval "$SAVE" --shot armed-floor3 \
  --reload '/?mode=solo&scenario=nope' --until "document.querySelector('[data-role=boot-error]')" \
  --eval "document.querySelector('[data-role=boot-error]').textContent" \
  --assert "!window.world || window.world.seed !== 18" --eval "$SAVE" --shot unknown-scenario
```

- **Stage.** The `armed` eval returns `weapon: "machinegun"` and `hp 240/240`, and the still shows the machine gun with its mod bar and `Grenade 30`.
- **Wins over the save.** All three `$SAVE` evals return the same seed with `floor: 1`. The first run takes no `seed=`, because a seeded run is never saved.
- **Unknown.** The boot-error text names `"nope"`, says the saved run is untouched, and lists the known scenarios. No world starts.
- **Look of a scene (Lane A).** Navigate to the same URL and screenshot after the beat named in the scenario's comment in `src/game/scenarios.ts`.

Suite that covers this: `pnpm run test:e2e:deep-link`.

Last proven 2026-10-02 at build 771+ in `e2e/output/verify/2026-10-03T06-15-45-939Z-scenario-deep-links/`: save seed 700681047 on floor 1 before and after, `armed` on floor 3 with the machine gun at 240 HP, and the unknown-scenario screen.

## Gotchas

- The save envelope shape changed over time. Read both `env.world.seed` and `env.seed`.
- The save `tick` keeps rising between the first eval and the reload, because the first page keeps autosaving. Compare the seed, not the tick.
- Group scenarios land their beat after a delay. Read the stage function for the tick to wait for.
