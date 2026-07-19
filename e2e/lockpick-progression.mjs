// fix/lockpick-progression — the previously-blocked bunker mission, end to end.
//
// Fixture `bunker-heist` (seed 7 floor 3): steal-the-briefcase with the target
// in a bunker core behind THREE locked L2 doors — the exact layout players
// could never finish. One deterministic run proves the whole unlock path:
//   1. lock prompt shows at the outer airlock door ("Lock II · Use to pick"),
//   2. pick channel #1 with the on-door progress ring (3.5s, deterministic),
//   3. pick channel #2 through the vestibule,
//   4. grenade BREACH of the core door (the loud alternative — costs hp+noise),
//   5. briefcase auto-grab → MISSION COMPLETE → exit unlocked.
import { recordFeature } from './record-feature.mjs'

await recordFeature({
  name: 'lockpick-progression',
  world: 'bunker-heist',
  script: 'bunker-heist',
  stills: [
    { tick: 40, label: '01-approach' },
    { tick: 60, label: '02-lock-prompt' },
    { tick: 190, label: '03-picking-ring' },
    { tick: 248, label: '04-outer-open' },
    { tick: 335, label: '05-picking-inner' },
    { tick: 500, label: '06-guard-band-circuit' },
    { tick: 538, label: '07-grenade-breach' },
    { tick: 628, label: '08-briefcase' },
    { tick: 690, label: '09-mission-complete' },
  ],
  readState: () => {
    const w = window.__world
    const door = (x, y) => w.entities.find((e) => e.door && Math.abs(e.pos.x - x) < 0.6 && Math.abs(e.pos.y - y) < 0.6)
    const pl = w.entities.find((e) => e.playerCtl)
    return {
      outer: door(40.5, 53.5)?.door,
      inner: door(38.5, 53.5)?.door,
      core: door(26.5, 55.5)?.door,
      briefcase: !!pl?.playerCtl?.inventory?.some((s) => s.itemId === 'briefcase'),
      hp: pl?.health?.hp,
      downed: !!pl?.playerCtl?.downed,
      missionComplete: w.mission.complete,
      exitUnlocked: w.mission.exitUnlocked,
      gameOver: w.gameOver,
    }
  },
  expect: (s) => [
    !(s.outer?.open && !s.outer?.locked) && 'outer airlock door not picked open',
    !(s.inner?.open && !s.inner?.locked) && 'inner airlock door not picked open',
    !(s.core?.open && !s.core?.locked) && 'core door not breached open',
    !s.briefcase && 'briefcase never grabbed',
    !s.missionComplete && 'mission not complete — the progression blocker is BACK',
    !s.exitUnlocked && 'exit did not unlock on mission completion',
    s.downed && 'player ended the heist downed',
    s.gameOver && 'unexpected game over',
  ].filter(Boolean),
})
