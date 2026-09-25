// #roll-douses-fire — STOP, DROP, AND ROLL headline video (exact world state).
// Injects the committed `combat-stage` snapshot with the crowd cleared and the
// player parked on the open lane, ALREADY ABLAZE with a fresh 240-tick weapon
// burn (barrel/`incendiary` ignition; the molotov was culled). Two runs off the SAME world:
//   • stopDropRoll    : burn for a beat, then roll twice — roll 1 (tick 30)
//                       smothers 150 ticks, roll 2 (tick 75) kills the rest.
//                       Burn ends at tick 75; exactly 18 hp lost (9 DOT ticks, tick 0 included).
//   • stopDropControl : never roll — the same burn runs its full 240 ticks and
//                       costs 54 hp (27 DOT ticks).
// The tick math is pinned EXACTLY (dot 2 / interval 9 / douse 150 / roll cycle
// 36) — any drift in the tuning fails the run, not just the vibes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage with only the player left, parked on the lane at full hp and
 * already burning: a fresh 240-tick ignition (until = tick 240, world tick 0). */
const ablaze = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 6, y: 11 }
  p.prevPos = { x: 6, y: 11 }
  p.facing = 0
  p.health.hp = p.health.max
  p.fx = { burning: { until: w.tick + 240 } }
  w.entities = [p]
  return w
}

const MAX_HP = ablaze().entities[0].health.max

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    playerHp: pl?.health?.hp ?? null,
    burning: !!pl?.fx?.burning,
    playerDowned: !!pl?.playerCtl?.downed,
    gameOver: w.gameOver,
  }
}

let ok = true

// Headline: two rolls smother the burn at tick 75 — exactly 16 hp paid.
ok =
  (await recordFeature({
    name: 'roll-douse-stop-drop-roll',
    world: ablaze(),
    script: 'stopDropRoll',
    params: { zoom: 2.4 }, // close enough that the ember pulse and steam puff read
    stills: [
      { tick: 6, label: '01-ablaze' },
      { tick: 28, label: '02-burning-hp-draining' },
      { tick: 36, label: '03-first-roll-steam' },
      { tick: 78, label: '04-second-roll-doused' },
      { tick: 140, label: '05-clean-no-pulse' },
      { tick: 220, label: '06-standing-healthy' },
    ],
    readState,
    expect: (s) => [
      s.burning && 'still burning after two rolls — the douse failed',
      s.playerHp !== MAX_HP - 18 && `hp should be exactly ${MAX_HP - 18} (9 DOT ticks), got ${s.playerHp}`,
      s.playerDowned && 'player went down despite dousing',
      s.gameOver && 'unexpected game over',
    ],
  })) && ok

// Control: same ignition, no rolls — the burn runs all 240 ticks for 54 hp.
ok =
  (await recordFeature({
    name: 'roll-douse-control-burnout',
    world: ablaze(),
    script: 'stopDropControl',
    params: { zoom: 2.4 },
    stills: [
      { tick: 6, label: '01-ablaze' },
      { tick: 120, label: '02-still-burning' },
      { tick: 235, label: '03-burned-the-full-course' },
    ],
    readState,
    expect: (s) => [
      s.burning && 'burn failed to expire on its own by tick 240',
      s.playerHp !== MAX_HP - 54 && `control hp should be exactly ${MAX_HP - 54} (27 DOT ticks), got ${s.playerHp}`,
      s.gameOver && 'unexpected game over',
    ],
  })) && ok

if (!ok) process.exitCode = 1
