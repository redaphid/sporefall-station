// HOMING REWORK proof video (playtest: "The homing mod sucks. It mostly just
// curves the bullets into walls."). Runs the `homing-demo` scenario with the
// proven `shooting` timeline: a homing-2 pistol fires east down a lane past a
// cover wall hiding the NEAREST thug — the old global-nearest homing's bait —
// with two more thugs visible in the open. The reworked seeker must kill both
// visible thugs (the off-axis one via a real curve), while every round flies
// STRAIGHT past the cover and the bunkered thug survives untouched.
import { record } from './lib.mjs'

await record({
  name: 'feature-homing-rework',
  params: { mode: 'solo', seed: 7, scenario: 'homing-demo', script: 'shooting' },
  stills: [
    { tick: 20, label: '01-stage' },
    { tick: 205, label: '02-planted-at-the-lane' },
    { tick: 250, label: '03-straight-past-cover' },
    { tick: 300, label: '04-curving-into-the-open-thug' },
    { tick: 430, label: '05-aftermath-bunkered-untouched' },
  ],
  readState: () => {
    // Dead bodies are SWEPT from w.entities, so of the 3 staged thugs only the
    // survivors remain — the whole assert is "exactly the bunkered one is left,
    // untouched". (Bunkered sits at (14.5,8.5); visible marks at y ≥ 11.)
    const w = window.__world
    const thugs = w.entities.filter((e) => e.archetype === 'thug' && !e.dead)
    const pl = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      gameOver: w.gameOver,
      survivors: thugs.map((t) => ({ x: t.pos.x, y: t.pos.y, hp: t.health?.hp ?? null })),
      playerHp: pl?.health?.hp ?? null,
    }
  },
  expect: (s) => [
    s.survivors.length !== 1 && `expected exactly the bunkered survivor, saw ${JSON.stringify(s.survivors)}`,
    !s.survivors.some((t) => t.y < 10) && 'the bunkered thug died — rounds still reach behind cover',
    s.survivors.some((t) => t.y < 10 && t.hp !== 24) && 'bunkered thug took damage — a round curved into/past the wall',
    s.survivors.some((t) => t.y >= 10) && 'a visible thug survived — homing stopped connecting',
    s.gameOver && 'unexpected game over',
  ].filter(Boolean),
})
