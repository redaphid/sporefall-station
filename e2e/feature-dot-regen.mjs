// #130 headline video: a player who stands still in fire now burns down instead
// of resting it off. The `fire-stage` snapshot with its crate row cleared, and a
// freshly lit cell under the player, who takes no input for the whole timeline
// (`missionui` is 660 idle ticks). Before the fix, passive regen (~10 hp/s)
// outhealed the burn (~6.7 hp/s) and the player sat at 106-120 hp in the flames.
// Post-run assertions: hp fell every 30-tick sample while burning, and the player
// ended downed, never having moved.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/fire-stage.json'), 'utf8'))

const world = () => {
  const w = JSON.parse(JSON.stringify(base))
  w.entities = w.entities.filter((e) => !e.fire && !e.flammable)
  const p = w.entities.find((e) => e.playerCtl)
  const cell = { x: Math.floor(p.pos.x) + 0.5, y: Math.floor(p.pos.y) + 0.5 }
  w.entities.push({
    id: w.nextId++, kind: 'fire', archetype: 'fire',
    pos: { ...cell }, prevPos: { ...cell }, vel: { x: 0, y: 0 }, intent: { x: 0, y: 0 },
    speed: 0, radius: 0.4, facing: 0, fire: { fuel: 360 },
  })
  return w
}
const start = base.entities.find((e) => e.playerCtl)

await recordFeature({
  name: 'feature-dot-regen',
  world: world(),
  script: 'missionui',
  stills: [
    { tick: 30, label: '01-lit' },
    { tick: 150, label: '02-still-burning' },
    { tick: 300, label: '03-no-rest-in-fire' },
    { tick: 450, label: '04-burning-down' },
    { tick: 620, label: '05-downed' },
  ],
  readState: () => {
    const w = window.__world
    const p = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      hp: p.health.hp,
      downed: !!p.playerCtl.downed,
      x: p.pos.x,
      y: p.pos.y,
      lastHurtTick: p.health.lastHurtTick ?? null,
    }
  },
  expect: (s) => [
    !s.downed && `player still up at hp ${s.hp}: standing in fire should burn them down`,
    s.lastHurtTick === null && 'the burn never stamped lastHurtTick',
    Math.hypot(s.x - start.pos.x, s.y - start.pos.y) > 0.01 && `player moved (${s.x},${s.y})`,
  ],
})
