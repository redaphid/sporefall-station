# Combat and weapon mods

The player fights through a floor with one permanent gun. Damage is scaled by each enemy's resistances, slotted mods change what a hit does (for example `incendiary` sets targets `burning`), and enemies react in their AI mode: they hunt, swing back, or break off and flee when hurt.

## Sub-features

- `fire`: holding attack while aimed at an enemy lands `hit` events and lowers its HP, scaled by its `resist.physical`.
- `mod`: a slotted mod shows in the player's `mods` and changes the hit (`incendiary` adds `burning` to the target's `fx`).
- `react`: a hurt enemy changes AI `mode` (`hunt`, `flee`) and can hurt the player back.

## How to get to it (user POV)

- In any run, move with WASD or the arrow keys (left stick on touch), aim with the mouse (right stick), and hold Space or J to fire.
- Walk over a mod pickup to slot it into the weapon's mod bar under the HP bar.
- `?scenario=armed` starts on floor 3 with a heavily modded machine gun (see [scenario deep links](./scenario-deep-links.md)).

## Driving it with pt.sh

Preconditions: `pnpm install` has run in this checkout. No server is needed. Pick a fresh `<name>` per run.

- **Stage.** `$S/pt.sh combat new --seed 31337`, then `$S/pt.sh combat spawn npc brute 1.5 6`. The spawn reply is the brute (id 223 on this seed) with `hp 95/95` and `resist.physical 0.35`. The player is id 222 with a `pistol` and no mods.
- **Fire.** `$S/pt.sh combat step 90 '{"aimAt":223,"attack":true}'`. The reply's `events.hit` is above 0. `$S/pt.sh combat get 223` shows `health.hp` below 95.
- **Mod.** `$S/pt.sh combat addMod 222 incendiary` returns `mods:[{"id":"incendiary","stacks":1}]`. Repeat the fire step, then `$S/pt.sh combat look`. The brute's entry carries `"fx":["burning"]` and a lower `hp`.
- **React.** In the same `look`, the brute's `mode` and the player's `hp` show how the fight went.
- **Look of it (Lane A).** Open `/?mode=solo&seed=31337&debug` in your own claude-in-chrome tab, run the same `spawn`, `addMod`, and `step` lines through `sporefall.verb(...)`, and take stills before and after.

Last proven 2026-10-02 at build 771+ (evidence `e2e/output/verify/pt-combat/transcript.log`): the pistol burst took the brute from 95 to 70 HP with 5 hits; after `incendiary`, 14 hits took it to 23 HP and left it `burning`, and it broke off in `flee` mode while the player sat at 106/120.

## Gotchas

- `look` lists only entities inside its radius (default 12 tiles). A fleeing enemy can drop out of it, so `get <id>` before concluding it died. A death shows as `events.death`.
- Entity ids depend on seed and spawn order. Read the id from the `spawn` reply instead of hardcoding 223.
- `pt.sh <name> new` resets that name's transcript. Reuse a name only to replace its evidence.
- There is no picture in this lane. A claim about how a hit or a burn looks needs a Lane A still.
