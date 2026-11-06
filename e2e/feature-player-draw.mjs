// The player's draw (feat/player-draw-1106): a Rivet Driver player arrives on
// the floor armed, stands, and the gun comes out of the holster in the
// motion-captured quickdraw, ending IN the braced aim; then it strafes north and
// south with the aim held east (aimwalk), stands (aim) and backpedals west. The
// draw plays once: a step after it never re-draws. Mid-run the gun goes to a
// wrench and back while the player stands, and the quickdraw plays again. World: the combat stage with
// the player alone, facing east.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 10, y: 11 }
  p.prevPos = { x: 10, y: 11 }
  p.facing = 0
  p.health = { hp: 1e6, max: 1e6, iframes: 0 }
  p.combat = { weapon: 'pistol', cooldown: 0 }
  w.entities = [p]
  return w
}

// The hotbar swap, done on the live world: the gun goes down for 40 ticks and comes back up while the player stands.
const swap = (weapon) => (page) =>
  page.evaluate((w) => {
    const p = window.__world.entities.find((e) => e.playerCtl)
    p.combat.weapon = w
  }, weapon)

const readState = () => {
  const w = window.__world
  const p = w.entities.find((e) => e.playerCtl)
  return { tick: w.tick, x: p.pos.x, y: p.pos.y, facing: p.facing, weapon: p.combat?.weapon }
}

const ok = await recordFeature({
  name: 'player-draw',
  world: stage(),
  script: 'playerDraw',
  params: { zoom: 3, theme: 'swampspace-hires' },
  stills: [
    { tick: 30, label: '00-aim-after-spawn-draw' },
    { tick: 80, label: '01-strafe-north' },
    { tick: 100, label: '02-swap-to-wrench', act: swap('wrench') },
    { tick: 140, label: '03-gun-back', act: swap('pistol') },
    { tick: 170, label: '04-aim' },
    { tick: 215, label: '05-backpedal' },
  ],
  readState,
  expect: (s) => [
    s.weapon !== 'pistol' && `expected the player still holding the pistol, got ${s.weapon}`,
    Math.abs(s.facing) > 0.05 && `expected the aim held east the whole run, facing ${s.facing}`,
    s.x > 9.5 && `expected the backpedal to carry the player west of x 9.5, at ${s.x}`,
  ],
})

process.exit(ok ? 0 : 1)
