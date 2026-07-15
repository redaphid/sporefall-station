// #53 — WEAPON MODS signature-gun videos (exact world state + real systems).
// Injects the committed `combat-stage` snapshot with the player re-armed to a
// specific MODDED gun, replays the proven `shooting` timeline, and captures a
// still per beat + an asserted mp4 — one distinct signature gun per recording
// ("all varieties, always"): ricochet-freeze-shotgun, homing pistol, nuke cannon,
// vampire SMG. Effects are asserted on the post-run world (thugs frozen/cleared).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage + the player re-armed to `weaponId` with `mods` (slotted so the
 * fire-site resolver picks them up). Optionally lower player hp to show lifesteal. */
const armed = (weaponId, mods, hp) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = weaponId
  p.playerCtl.inventory = [{ itemId: weaponId, qty: 99, mods }]
  p.playerCtl.activeSlot = 0
  if (hp !== undefined) p.health.hp = hp
  return w
}

const stills = [
  { tick: 20, label: '01-injected' },
  { tick: 200, label: '02-take-aim' },
  { tick: 255, label: '03-opening-fire' },
  { tick: 320, label: '04-effects' },
  { tick: 380, label: '05-aftermath' },
]

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  const thugs = w.entities.filter((e) => e.archetype === 'thug')
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    thugsAlive: thugs.filter((e) => !e.dead).length,
    frozen: w.entities.filter((e) => e.fx && e.fx.frozen).length,
    projectiles: w.entities.filter((e) => e.kind === 'projectile').length,
    playerHp: pl?.health?.hp ?? null,
    playerDowned: !!pl?.playerCtl?.downed,
  }
}

const guns = [
  {
    name: 'sig-ricochet-freeze-shotgun',
    world: armed('shotgun', [{ id: 'bulk', stacks: 2 }, { id: 'bounce', stacks: 1 }, { id: 'frost', stacks: 1 }]),
    // A wall-hugging spray that freezes then shatters a room.
    expect: (s) => [s.thugsAlive === 3 && 'freeze-shotgun cleared nothing', s.gameOver && 'unexpected game over'],
  },
  {
    name: 'sig-homing-pistol',
    world: armed('pistol', [{ id: 'homing', stacks: 3 }, { id: 'rapid', stacks: 2 }]),
    expect: (s) => [s.thugsAlive === 3 && 'homing pistol hit nothing', s.playerDowned && 'player downed'],
  },
  {
    name: 'sig-nuke-cannon',
    world: armed('machinegun', [{ id: 'explosive', stacks: 2 }, { id: 'overload', stacks: 3 }]),
    expect: (s) => [s.thugsAlive === 3 && 'nuke cannon cleared nothing', s.gameOver && 'unexpected game over'],
  },
  {
    name: 'sig-vampire-smg',
    world: armed('machinegun', [{ id: 'lifesteal', stacks: 3 }, { id: 'pierce', stacks: 2 }, { id: 'rapid', stacks: 1 }], 40),
    // Mows the crowd and heals off it — survives despite starting at 40 hp.
    expect: (s) => [s.thugsAlive === 3 && 'vampire SMG hit nothing', s.playerDowned && 'player bled out'],
  },
]

let ok = true
for (const g of guns) {
  const pass = await recordFeature({ name: g.name, world: g.world, script: 'shooting', stills, readState, expect: g.expect })
  ok = ok && pass
}
if (!ok) process.exitCode = 1
