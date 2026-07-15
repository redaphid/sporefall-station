import { record } from './lib.mjs'

// Opening doors: swing an unlocked door open, then channel a lockpick on a
// locked one and walk through.
await record({
  name: 'e2e-doors',
  params: { mode: 'solo', class: 'soldier', seed: 7, scenario: 'doors', script: 'doors' },
  stills: [
    { tick: 20, label: '01-spawn' },
    { tick: 150, label: '02-approach' },
    { tick: 210, label: '03-unlocked-open' },
    { tick: 300, label: '04-picking' },
    { tick: 430, label: '05-lock-popped' },
    { tick: 490, label: '06-through' },
  ],
  readState: () => {
    const w = window.__world
    const at = (x, y) => w.entities.find((e) => e.door && Math.abs(e.pos.x - x) < 0.6 && Math.abs(e.pos.y - y) < 0.6)
    const pl = w.entities.find((e) => e.playerCtl)
    return { unlockedOpen: !!at(6, 11)?.door.open, lockPicked: !!at(11, 11) && !at(11, 11).door.locked, lockedOpen: !!at(11, 11)?.door.open, px: +pl.pos.x.toFixed(1), gameOver: w.gameOver }
  },
  expect: (s) => [
    !s.unlockedOpen && 'unlocked door never opened',
    !s.lockPicked && 'locked door never unlocked',
    !s.lockedOpen && 'picked door not left open',
    s.px < 13 && 'player did not walk through the doors',
    s.gameOver && 'unexpected game over',
  ].filter(Boolean),
})
