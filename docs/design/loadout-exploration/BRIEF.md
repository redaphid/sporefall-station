# Design brief: a deep loadout mechanic for Sporefall Station

## The owner's ask, verbatim

> I want to explore the idea of having 2 weapons you build, instead of one. And the ability to unload mods, which drops them in the world. We have some feature-flagged off noita stuff. I want you to go above and beyond to create a deep mechanic, that works as a mini puzzle in the game, that very significantly effects gameplay. This is with or without the 2nd gun. The only reason I'd want a 2nd gun is to give the players some agency when building their weapons, instead of randomly taking stuff off the ground. I want them to be able to prepare for a boss who, for example, is weak to lightning

> I'm looking to add significant, meaningful combinatorial complexity

(Second line sent mid-design. It is the headline success criterion.)

Read that twice. The goal is **agency and preparation**, where building a weapon is a mini-puzzle that very significantly changes play. A second gun is a *means*, not the goal. "Unload mods, which drops them in the world" is an explicit ask.

## Who plays this

The owner and his nephews (kids), on phones over Bluetooth LE, co-op, with no cell service. A controller (8BitDo Lite 2) is the only input at the couch, so every interaction must be **pad-first**. The pace is fast and arcadey: a new floor every couple of minutes, and you kill everything you see. Anything that needs a long menu session in the middle of a fight fails.

## What exists today (read the code, do not trust this summary blindly)

Repo: the git checkout you are in, at `origin/main`.

- `src/game/data/mods.ts`: 18 mods as pure data. There are stat mods (`add`/`mul`), behaviour mods (pierce, bounce, homing, explosive, split, splinterShot, lifesteal), element payloads (`frost`, `incendiary`, `shock`, each an `onHit` status), and a trigger (`detonator`).
- `src/game/systems/resolveWeapon.ts`: the default mode folds *every* mod into every shot. `onHit` keeps only ONE element per hit, and the rest are silently dropped.
- `src/game/systems/modSequence.ts`: the **Noita-style sequencing prototype**, behind the `sequencedMods` flag in `src/app/featureFlags.ts` (off by default; `World.modCasting === 'sequence'`). Each weapon's mod list is an ordered wand. Modifiers ride on the next payload, a payload ends a cast, and running off the end wraps and triggers a recharge. Weapons have a `slots` / `castsPerTrigger` / `rechargeOnWrap` shape (`src/game/data/items.ts`: pistol 4/1/20, shotgun 4/2/30, machine gun 6/1/45, sledgehammer 8/1/75). Reordering is a swap input packed into `InputCmd` (`packModSwap`), shown as tap-two-to-swap chips.
- `src/game/data/elements.ts`: `burning`, `frozen`, `wet`, `electrified`, `poisoned`, `spore`. Wet plus shock arcs.
- `src/game/data/npcs.ts`: every NPC has a `resist` table (1 is neutral, below 1 resists, 0 is immune, above 1 is weak). It is a rock-paper-scissors roster: the brute shrugs off bullets (burn it), the cinder shrugs off fire (shoot it), and the sporeling ignores toxins.
- Bosses: the Mireclaw Alpha (`src/game/systems/mireclaw.ts`), plus Vigil, Echo, and Sealkeeper (PR #77, `docs/design/boss-variety.md`). No telegraph system exists yet (issue #1).
- `src/game/systems/draft.ts` / `src/ui/draftScreen.ts`: an "offered three, take one" floor draft that is written but only wired in `?e2e`. Issue #84 is wiring it now in a parallel branch.
- **The one-weapon rule** is the standing decision (PR #53): one permanent weapon, no weapon loot, and mods are the progression. The owner's complaint that caused it: *he only used the pistol because it carried the mods.* A second **built** gun is the owner's own proposal now, so it is on the table. Weapon *loot* coming back is not.
- In-flight work you must compose with rather than duplicate: #84 floor draft, #87 elements differ by verb (not DoT), #88 the mod UI shows what actually executes, and #89 floor modifiers.

Read `git show origin/docs/inspo:INSPO.md` §1, §2, §7, and §8, the design history. It holds the rulings that constrain you:
1. Elements must differ by **verb**, not number.
2. Depth beats breadth.
3. Handling (fire rate, recharge) is an artifact of composition.
4. Run-to-run variety is the payoff, not power, and a dominant build is a failure.
5. Scarcity creates the combination.
6. Free reordering is not optional ("otherwise it's a slot machine").
7. Composition, not alternation: the arrangement makes *different projectiles*.
8. A grammar, not a table.
9. The UI must show what will actually execute.

Its open question matters here: *does "bad combos are funny" survive co-op?*

## Hard engineering constraints

- **Determinism.** The sim is a pure function of seed plus per-tick `InputCmd`. No `Math.random` or `Date.now` in `src/game/`. Any new player action must be an `InputCmd` field the host applies, and a client never mutates locally.
- **BLE budget.** Snapshots are small. A new per-entity state has a wire cost, so name it.
- **Layout RNG** must not be perturbed for existing seeds (fork a new RNG stream).
- `src/game/` imports no DOM.

## What to produce

One design document, written to the path you are given. Structure:

1. **The pitch in three sentences a 10-year-old would get.**
2. **The core loop, beat by beat.** What does a player do on a normal floor, before a boss, and during a boss? Where exactly is the puzzle?
3. **The puzzle, precisely.** State the rules, then give three worked examples of arrangements and what they produce. Include one "aha" combination and one trap. Show why it is a puzzle and not a lookup (hidden or partial information, constraints, trade-offs).
4. **Boss preparation.** How does a player *learn* a boss is weak to lightning before the fight, and how do they act on it? Walk through a concrete boss.
5. **Unloading mods into the world.** What it enables: stashing, trading between co-op players, using mods as world objects. What stops it from being degenerate? For example, if unload plus re-pick is free, is scarcity dead?
6. **Two guns: yes or no.** Decide and defend it. If yes, say how switching works on a pad, whether both are ever active at once, and how it avoids re-creating "I only use the one with the mods". If no, say how your design delivers the same agency.
7. **Co-op.** What does the second player do? Does it make kids talk to each other?
8. **Data shape.** The TypeScript types you would add or change (entity fields, `InputCmd` fields, registry entries), how they serialize, and their wire cost.
9. **Pad UI.** Controls and screens. Nothing needs a mouse.
10. **Risks and the failure mode to measure.** Name the dominant-strategy risk and the sweep that would detect it.
11. **The smallest prototype that proves the fun.** A thin slice behind a flag that could be built in one focused session and played on the `armed` scenario or a boss scenario. Name the files it touches.

Be concrete, ground every claim about existing code in a file path, and be bold. The owner asked you to go above and beyond. Do NOT edit code, commit, or push; this is design only. Keep the document under ~1500 lines of markdown. Return the file path and a five-line summary.
