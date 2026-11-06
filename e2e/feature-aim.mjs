// Aiming with no aim frames shipped yet: the held gun rises from the hip to the
// raised hold (src/render/weaponPose.ts raisedPose). A pistol player stands at
// the centre of a ring of eight drowners; each engages, winds up (16 ticks),
// raises its harpoon gun at the player and fires, strafing round the ring, so
// all eight facings of the raised hold are on screen at once. The player cannot
// die and holds a pistol, so it aims too (always, for a player with a gun).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const CX = 10
const CY = 11
const RING = 3.2

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = Math.PI / 2
  p.health = { hp: 1e6, max: 1e6, iframes: 0 }
  p.combat = { weapon: 'pistol', cooldown: 0 }
  w.entities = [p]
  return w
}

const ring = (page) =>
  page.evaluate(
    ({ CX, CY, RING }) => {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        window.sporefall.verb(`spawn npc drowner ${CX + Math.cos(a) * RING} ${CY + Math.sin(a) * RING}`)
      }
    },
    { CX, CY, RING },
  )

const readState = () => {
  const w = window.__world
  const d = w.entities.filter((e) => e.archetype === 'drowner' && !e.dead)
  return {
    tick: w.tick,
    drowners: d.length,
    aggro: d.filter((e) => e.ai?.mode === 'aggro').length,
    drawn: d.filter((e) => e.ai?.draw && w.tick >= e.ai.draw.readyAt).length,
  }
}

const ok = await recordFeature({
  name: 'aim-raised',
  world: stage(),
  params: { zoom: 2.5, theme: 'swampspace-hires' },
  stills: [
    { tick: 2, label: '00-spawn', act: ring },
    { tick: 12, label: '01-winding-up' },
    { tick: 40, label: '02-aiming' },
    { tick: 80, label: '03-aiming' },
    { tick: 140, label: '04-aiming' },
  ],
  readState,
  expect: (s) => [
    s.drowners < 6 && `expected the ring alive, got ${s.drowners}`,
    s.aggro < 6 && `only ${s.aggro} drowners engaged`,
    s.drawn < 6 && `only ${s.drawn} drowners past their wind-up`,
  ],
})

process.exit(ok ? 0 : 1)
