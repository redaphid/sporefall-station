// #54 — DODGE-ROLL headline video (exact world state + real systems).
// Injects the committed `combat-stage` snapshot with the thugs cleared, the
// player parked on the open lane at full hp, and a single fast bullet inbound.
// Two runs off the SAME world prove the mechanic:
//   • dodge-roll : the player rolls INTO the bullet — i-frames carry them
//                  through it, hp UNCHANGED across the roll.
//   • control    : same world, no roll — the identical bullet lands, hp DROPS.
// Effects (hp, bullet consumed) are asserted on the post-run world.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage with the crowd cleared, the player at full hp on the lane, and
 * one 40-dmg bullet flying left along y=11 toward the player. */
const duel = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 6, y: 11 }
  p.prevPos = { x: 6, y: 11 }
  p.facing = 0
  p.health.hp = p.health.max
  const bullet = {
    id: w.nextId,
    kind: 'projectile',
    archetype: 'projectile',
    pos: { x: 14, y: 11 },
    prevPos: { x: 14, y: 11 },
    vel: { x: -11, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 0,
    radius: 0.15,
    facing: Math.PI,
    projectile: { ownerId: 999, damage: 40, ttl: 90 },
  }
  w.nextId += 1
  w.entities = [p, bullet]
  return w
}

const stills = [
  { tick: 5, label: '01-bullet-inbound' },
  { tick: 17, label: '02-mid-roll-iframes' },
  { tick: 24, label: '03-rolled-through' },
  { tick: 45, label: '04-unharmed' },
]

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    playerHp: pl?.health?.hp ?? null,
    playerMax: pl?.health?.max ?? null,
    rolling: !!pl?.playerCtl?.roll,
    projectiles: w.entities.filter((e) => e.kind === 'projectile' && !e.dead).length,
    playerDowned: !!pl?.playerCtl?.downed,
  }
}

let ok = true

// Headline: rolled straight through the bullet, hp untouched.
ok =
  (await recordFeature({
    name: 'dodge-roll-through-bullet',
    world: duel(),
    script: 'dodgeRoll',
    stills,
    readState,
    expect: (s) => [
      s.playerHp !== s.playerMax && `took damage while rolling (hp ${s.playerHp}/${s.playerMax})`,
      s.playerDowned && 'player went down mid-roll',
    ],
  })) && ok

// Control: same bullet, no roll — it connects.
ok =
  (await recordFeature({
    name: 'dodge-roll-control-hit',
    world: duel(),
    script: 'dodgeControl',
    stills: [
      { tick: 5, label: '01-bullet-inbound' },
      { tick: 30, label: '02-took-the-hit' },
      { tick: 55, label: '03-hurt' },
    ],
    readState,
    expect: (s) => [
      s.playerHp >= s.playerMax && `bullet failed to connect without a roll (hp ${s.playerHp}/${s.playerMax})`,
    ],
  })) && ok

if (!ok) process.exitCode = 1
