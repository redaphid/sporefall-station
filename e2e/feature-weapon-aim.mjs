// fix/weapon-aim-and-pistol-art — the held weapon points at the CONTINUOUS aim
// (full 360°, INCLUDING straight down), and the pistol reads as a pistol.
//
// Two cuts against a stripped combat-stage (thugs removed so nothing interrupts
// the pose — a clean render showcase):
//   1. weapon-aim-pistol: a PISTOL held while facing E, SE, S (straight DOWN),
//      SW and W — the barrel tracks the aim heading, not the 8-way body sprite,
//      and (the bug this fixes) it POINTS DOWN. The improved silhouette reads as
//      grip + slide + barrel + muzzle at gameplay zoom.
//   2. weapon-aim-down-swing: a melee weapon SWUNG while facing straight down —
//      the arc sweeps around the downward aim (composes on top of it), proving
//      idle = points at aim and attacking = arc about that aim.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage with the thugs stripped and the player armed to `weaponId`
 * (slotted so the fire-site + the renderer's skin agree). A clean, combat-free
 * stage: the player just stands and aims/swings. */
const staged = (weaponId, mods) => {
  const w = JSON.parse(JSON.stringify(base))
  w.entities = w.entities.filter((e) => e.playerCtl) // drop the thug line
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = weaponId
  p.playerCtl.inventory = [{ itemId: weaponId, qty: 99, ...(mods ? { mods } : {}) }]
  p.playerCtl.activeSlot = 0
  return w
}

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    weapon: pl?.combat?.weapon ?? null,
    facing: pl?.facing ?? null,
    playerHp: pl?.health?.hp ?? null,
  }
}

let ok = true

// Cut 1 — pistol pointing in five headings incl. straight down. Still ticks sit
// at the start of each 90-tick HOLD so the (video-recording-slow) screenshot
// still lands inside the hold window.
ok =
  (await recordFeature({
    name: 'weapon-aim-pistol',
    world: staged('pistol', undefined),
    script: 'aimShowcase',
    params: { zoom: 2 },
    stills: [
      { tick: 100, label: '01-east' },
      { tick: 195, label: '02-southeast' },
      { tick: 290, label: '03-DOWN' },
      { tick: 385, label: '04-southwest' },
      { tick: 480, label: '05-west' },
    ],
    readState,
    expect: (s) => [s.weapon !== 'pistol' && 'lost the pistol', s.gameOver && 'unexpected game over', s.playerHp <= 0 && 'player died'],
  })) && ok

// Cut 2 — melee swing around a downward aim.
ok =
  (await recordFeature({
    name: 'weapon-aim-down-swing',
    world: staged('bat', undefined),
    script: 'aimDownSwing',
    params: { zoom: 2 },
    stills: [
      { tick: 80, label: '01-swing-a' },
      { tick: 120, label: '02-swing-b' },
    ],
    readState,
    expect: (s) => [s.weapon !== 'bat' && 'lost the bat', s.gameOver && 'unexpected game over', s.playerHp <= 0 && 'player died'],
  })) && ok

if (!ok) process.exitCode = 1
