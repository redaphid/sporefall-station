// feat/weapon-sprites — HELD WEAPONS that SWING, and MODS that mutate the look.
// Injects the committed `combat-stage` snapshot with the player re-armed to a
// MELEE weapon, replays the `meleeSwing` timeline (march into the thug line and
// hold the attack), and captures a still per beat + an asserted mp4. Three cuts:
//   1. a plain SLEDGEHAMMER (big hammer silhouette, wide overhead arc),
//   2. a plain BAT (tapered club, faster cadence),
//   3. a sledgehammer with the INCENDIARY mod — the weapon wears the fire-orange
//      pickup hue + a glow, proving mods mutate the held sprite.
// The swing is deterministic (a pure function of the attack window), so the same
// tick yields the same arc every run; the mp4 is the human-visible proof.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage + the player re-armed to a melee `weaponId` (slotted with `mods`
 * so the fire-site + the renderer's skin both pick them up). */
const armed = (weaponId, mods) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = weaponId
  p.playerCtl.inventory = [{ itemId: weaponId, qty: 99, ...(mods ? { mods } : {}) }]
  p.playerCtl.activeSlot = 0
  return w
}

// Stills straddle the swing window so at least one lands mid-arc (attack cadence
// is deterministic: sledgehammer 28 ticks, bat 15 — several swings across 150).
const stills = [
  { tick: 20, label: '01-armed' },
  { tick: 150, label: '02-marching' },
  { tick: 176, label: '03-first-swing' },
  { tick: 182, label: '04-arc' },
  { tick: 210, label: '05-followthrough' },
  { tick: 300, label: '06-aftermath' },
]

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    weapon: pl?.combat?.weapon ?? null,
    thugsAlive: w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length,
    playerHp: pl?.health?.hp ?? null,
  }
}

const cuts = [
  {
    name: 'weapon-swing-sledgehammer',
    world: armed('sledgehammer', undefined),
    // A heavy weapon that reaches the line and staggers/kills at least one thug.
    expect: (s) => [s.weapon !== 'sledgehammer' && 'not wielding the sledgehammer', s.thugsAlive === 3 && 'sledge never connected', s.gameOver && 'unexpected game over'],
  },
  {
    name: 'weapon-swing-bat',
    world: armed('bat', undefined),
    expect: (s) => [s.weapon !== 'bat' && 'not wielding the bat', s.gameOver && 'unexpected game over'],
  },
  {
    name: 'weapon-swing-sledgehammer-incendiary',
    world: armed('sledgehammer', [{ id: 'incendiary', stacks: 2 }]),
    // Same swing, but the held sprite now wears the incendiary hue + glow.
    expect: (s) => [s.weapon !== 'sledgehammer' && 'not wielding the modded sledgehammer', s.gameOver && 'unexpected game over'],
  },
]

let ok = true
for (const c of cuts) {
  const pass = await recordFeature({ name: c.name, world: c.world, script: 'meleeSwing', stills, readState, expect: c.expect })
  ok = ok && pass
}
if (!ok) process.exitCode = 1
