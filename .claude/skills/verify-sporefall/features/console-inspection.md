# Console inspection

Every build, the deployed site included, exposes the live world as `window.world` and the read-only `window.sporefall` namespace, and logs one boot line advertising them. With `?debug`, `sporefall.verb(...)` mutates the world. Without it, `verb` refuses and explains the gate.

## Sub-features

- `reads`: `help`, `tick`, `session`, `player`, `entities(filter)`, `entity`, `mission`, `events`, `schema`, `serialize`, and `version` all answer. Returned objects are detached clones.
- `gate`: without `?debug`, `verb` returns a string containing `?debug` and mutates nothing.
- `writes`: with `?debug`, `verb('teleport', '<id> 3 3')` moves the player in the live world.

## How to get to it (user POV)

- Open DevTools on any build, or run JavaScript in the page from an agent's browser tool.

## Driving it with drive.mjs

Preconditions: doctor green.

- **Reads and gate (Lane B).** `--open '/?mode=solo&seed=7' --until-tick 10 --assert "sporefall.help().includes('sporefall.verb')" --assert "sporefall.verb('teleport ' + sporefall.player().id + ' 1 1').includes('?debug')" --assert "Object.isFrozen(sporefall)"`.
- **Writes (Lane B).** `--open '/?mode=solo&seed=7&debug' --until-tick 10 --eval "sporefall.verb('teleport', sporefall.player().id + ' 3 3')" --assert "sporefall.player().pos.x === 3"`.

Suite that covers this: `pnpm run e2e:ai-inspect`. Not yet driven through this skill.

## Gotchas

- `?debug` also dials the WebSocket debug hub on port 7810. With no hub, expect a console connection error. That error is not a page error, and `drive.mjs` still passes.
