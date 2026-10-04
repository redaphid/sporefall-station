// #86 balance sweep: how fast does gunfire raise the alarm on REAL floors?
// Run: pnpm exec tsx scripts/test/alarm-sweep.mts [seeds=40]
//
// For each seed, floors 1 and 2 (real populate + mission), one player at the
// spawn aiming along +x, kept alive with iframes so the sweep measures noise,
// not survival. Three trigger disciplines, 60 s each:
//   stray  — one shot, then silence
//   spaced — one shot every 3 s
//   held   — trigger held the whole time
// Prints, per floor, how many seeds reached each alarm level / lockdown and the
// median seconds it took.

import '../../src/game/populate'
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const SEEDS = Number(process.argv[2] ?? 40)
const TICKS = 60 * 30

type Discipline = 'stray' | 'spaced' | 'held'
const pulls = (d: Discipline, t: number): boolean => (d === 'held' ? true : d === 'spaced' ? t % 90 === 0 : t === 0)

const run = (seed: number, floor: number, d: Discipline): { firstAt: (number | undefined)[]; lockdownAt?: number } => {
  const w: World = createWorld(seed, 1)
  w.floor = floor
  if (floor !== 1) {
    // Build the real floor the way nextFloor does.
    w.level = createWorld(seed, floor).level
    w.rng = w.baseRng.fork(`sim:${floor}`)
  }
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  const firstAt: (number | undefined)[] = [undefined, undefined, undefined]
  let lockdownAt: number | undefined
  for (let t = 0; t < TICKS; t++) {
    p.health!.iframes = Math.max(p.health!.iframes, 2)
    p.dead = false
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: pulls(d, t), aimX: 1, aimY: 0 }]]))
    for (const e of w.events) if (e.type === 'alarmRaised') firstAt[e.level - 1] ??= t
    if (lockdownAt === undefined && w.mission.lockdownTick !== undefined) lockdownAt = t
  }
  return { firstAt, lockdownAt }
}

const median = (xs: number[]): string => {
  if (xs.length === 0) return '—'
  const s = [...xs].sort((a, b) => a - b)
  return (s[Math.floor(s.length / 2)] / 30).toFixed(1) + 's'
}

for (const floor of [1, 2]) {
  for (const d of ['stray', 'spaced', 'held'] as Discipline[]) {
    const lv: number[][] = [[], [], []]
    const ld: number[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = run(seed, floor, d)
      r.firstAt.forEach((t, i) => t !== undefined && lv[i].push(t))
      if (r.lockdownAt !== undefined) ld.push(r.lockdownAt)
    }
    console.log(
      `floor ${floor} ${d.padEnd(6)} | alarm1 ${lv[0].length}/${SEEDS} (${median(lv[0])}) | alarm2 ${lv[1].length}/${SEEDS} (${median(lv[1])}) | alarm3 ${lv[2].length}/${SEEDS} (${median(lv[2])}) | lockdown ${ld.length}/${SEEDS} (${median(ld)})`,
    )
  }
}
