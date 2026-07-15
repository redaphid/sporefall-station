import { record } from './lib.mjs'

// A full mission, start to finish: steal the briefcase (objective complete →
// MISSION COMPLETE banner, exit unlocks), then reach the exit to clear the floor.
await record({
  name: 'e2e-mission',
  params: { mode: 'solo', class: 'soldier', seed: 7, scenario: 'mission', script: 'mission' },
  stills: [
    { tick: 20, label: '01-spawn' },
    { tick: 170, label: '02-approach-briefcase' },
    { tick: 205, label: '03-mission-complete' },
    { tick: 245, label: '04-exit-open' },
    { tick: 292, label: '05-reach-exit' },
    { tick: 325, label: '06-floor-2' },
  ],
  readState: () => {
    const w = window.__world
    const pl = w.entities.find((e) => e.playerCtl)
    return { floor: w.floor, gameOver: w.gameOver, hp: pl.health.hp }
  },
  // Floor 2 is only reachable by completing the objective (which unlocks the
  // exit) and then standing on it — a full end-to-end win.
  expect: (s) => [
    s.floor < 2 && `never cleared the floor (floor ${s.floor})`,
    s.gameOver && 'unexpected game over',
  ].filter(Boolean),
})
