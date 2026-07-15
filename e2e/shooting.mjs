import { record } from './lib.mjs'

// Shooting: equip nothing extra — the soldier's pistol — and gun down three
// targets down the lane. Bullets → hits → kills.
await record({
  name: 'e2e-shooting',
  params: { mode: 'solo', class: 'soldier', seed: 7, scenario: 'shooting', script: 'shooting' },
  stills: [
    { tick: 20, label: '01-spawn' },
    { tick: 210, label: '02-take-aim' },
    { tick: 245, label: '03-opening-fire' },
    { tick: 290, label: '04-bullets-flying' },
    { tick: 345, label: '05-last-target' },
    { tick: 420, label: '06-cleared' },
  ],
  readState: () => {
    const w = window.__world
    const alive = w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length
    const pl = w.entities.find((e) => e.playerCtl)
    return { targets: 3, alive, hp: pl.health.hp, gameOver: w.gameOver }
  },
  expect: (s) => [
    s.alive !== 0 && `${s.alive} target(s) left standing`,
    s.gameOver && 'unexpected game over',
  ].filter(Boolean),
})
