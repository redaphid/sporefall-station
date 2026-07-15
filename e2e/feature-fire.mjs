// #50 backfill — FIRE element, exact world state.
// Injects the committed `fire-stage` snapshot (a lit crate row ending in a
// flammable bystander, hp 12; the player watching from the north) via `?world=`,
// then replays the input-free `burn` timeline — the REAL fire system does all the
// work: it spreads down the row, ignites the bystander, and burns it to death
// (~tick 100). Adversarial post-run assertions: the exact pinned bystander is
// dead + swept, NO flammable civilian survives, and the player — never in the
// flames — is completely untouched (full hp, hasn't moved).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/fire-stage.json'), 'utf8'))
const victim = fixture.entities.find((e) => e.flammable && e.archetype === 'civilian')
const player = fixture.entities.find((e) => e.playerCtl)
if (!victim) throw new Error('fire-stage fixture should pin a flammable civilian bystander')

await recordFeature({
  name: 'feature-fire',
  world: 'fire-stage',
  script: 'burn',
  stills: [
    { tick: 5, label: '01-injected' },
    { tick: 40, label: '02-spreading' },
    { tick: 80, label: '03-bystander-ablaze' },
    { tick: 120, label: '04-burned-down' },
    { tick: 175, label: '05-aftermath' },
  ],
  readState: () => {
    const w = window.__world
    const pl = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      gameOver: w.gameOver,
      ids: w.entities.map((e) => e.id),
      flammableCivsAlive: w.entities.filter((e) => e.archetype === 'civilian' && e.flammable && !e.dead).length,
      player: pl ? { hp: pl.health.hp, x: pl.pos.x, y: pl.pos.y } : null,
    }
  },
  expect: (s) => [
    s.ids.includes(victim.id) && `pinned bystander id ${victim.id} survived the fire`,
    s.flammableCivsAlive !== 0 && `${s.flammableCivsAlive} flammable civilian(s) still alive`,
    !s.player && 'player entity vanished',
    s.player && s.player.hp !== player.health.hp && `player took damage (hp ${player.health.hp} -> ${s.player.hp})`,
    s.player &&
      Math.hypot(s.player.x - player.pos.x, s.player.y - player.pos.y) > 0.01 &&
      `player moved from its post (${player.pos.x},${player.pos.y} -> ${s.player.x},${s.player.y})`,
    s.gameOver && 'unexpected game over',
  ],
})
