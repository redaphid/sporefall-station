import { record } from './lib.mjs'

// The showcase run: move → meet NPCs + grab a pickup → open a door → win a battle.
await record({
  name: 'gameplay-demo',
  params: { mode: 'solo', seed: 7, scenario: 'demo', script: 'demo' },
  stills: [
    { tick: 20, label: '01-spawn' },
    { tick: 300, label: '02-npc' },
    { tick: 430, label: '03-door' },
    { tick: 487, label: '04-engage' },
    { tick: 505, label: '05-battle' },
    { tick: 560, label: '06-victory' },
  ],
  readState: () => {
    const w = window.__world
    const live = (a) => w.entities.filter((e) => e.archetype === a && !e.dead).length
    const door = w.entities.filter((e) => e.door).sort((a, b) => Math.hypot(a.pos.x - 12, a.pos.y - 11) - Math.hypot(b.pos.x - 12, b.pos.y - 11))[0]
    const pl = w.entities.find((e) => e.playerCtl)
    // Inventory lives on the shared `loadout` component since the npc-inventory
    // merge — playerCtl no longer carries it.
    return { gameOver: w.gameOver, thugs: live('thug'), doorOpen: !!door?.door.open, bag: (pl.loadout?.inventory ?? []).reduce((n, i) => n + i.qty, 0), hp: pl.health.hp }
  },
  expect: (s) => [
    !s.doorOpen && 'door never opened',
    s.bag < 1 && 'medkit pickup missed',
    s.thugs !== 0 && `${s.thugs} thug(s) left alive`,
    (s.gameOver || !(s.hp > 0)) && 'player did not survive',
  ].filter(Boolean),
})
