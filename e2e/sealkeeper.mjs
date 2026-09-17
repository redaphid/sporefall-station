// @ts-check
// §4.3 The Sealkeeper proof: drive the `sealkeeper` scenario + script in a real
// browser and assert, from LIVE WORLD STATE, the fight's whole thesis —
//
//   1. the boss TAKES the lane: it backs to the only doorway, shuts it and
//      re-locks it (probed mid-clip, while the party is still shut in);
//   2. the lock it leaves is a MUNDANE, pickable one, never a biolock;
//   3. a GRENADE breaches it back open — the weapon becoming a tool, which is
//      the verb this boss exists to teach;
//   4. the player walks out through the hole.
//
// Point 1 has to be probed mid-run rather than asserted at the end, because by
// the final tick the door is deliberately open again. Records stills + mp4.
import { record } from './lib.mjs'

// Stage geometry — must match scenarios.setupSealkeeper (lane y=11, wall x=16).
const DOOR = { x: 16, y: 11 }

await record({
  name: 'e2e-sealkeeper',
  params: { mode: 'solo', seed: 11, scenario: 'sealkeeper', script: 'sealkeeper', e2e: '1' },
  stills: [
    { tick: 20, label: '01-the-lane-is-open' },
    { tick: 60, label: '02-lane-taken' },
    {
      tick: 140,
      label: '03-sealed-in',
      // Probe the SEALED state while it is still true: this is the assertion
      // that the boss actually did something, and it is gone by the last tick.
      act: async (page) => {
        await page.evaluate(
          ({ x, y }) => {
            const w = window.__world
            const d = w.entities.find(
              (e) => e.door && Math.abs(e.pos.x - (x + 0.5)) < 0.6 && Math.abs(e.pos.y - (y + 0.5)) < 0.6,
            )
            window.__sealProbe = d
              ? { open: d.door.open, locked: d.door.locked, lockLevel: d.door.lockLevel, sealKind: d.door.sealKind ?? null }
              : null
          },
          DOOR,
        )
      },
    },
    { tick: 200, label: '04-breach' },
    { tick: 260, label: '05-through-the-hole' },
    { tick: 340, label: '06-final' },
  ],
  readState: () => {
    const w = window.__world
    const pl = w.entities.find((e) => e.playerCtl)
    const boss = w.entities.find((e) => e.archetype === 'sealkeeper')
    const d = w.entities.find((e) => e.door)
    return {
      tick: w.tick,
      seal: window.__sealProbe ?? null,
      sealedCount: boss?.ai?.sealed ?? 0,
      bossAlive: !!boss && !boss.dead,
      doorOpen: !!d?.door?.open,
      doorLocked: !!d?.door?.locked,
      px: +(pl?.pos?.x ?? 0).toFixed(1),
      gameOver: w.gameOver,
    }
  },
  expect: (s) =>
    [
      !s.seal && 'never probed the door mid-clip (scenario geometry drifted?)',
      s.seal && s.seal.open && 'the Sealkeeper never SHUT the lane',
      s.seal && !s.seal.locked && 'it shut the door but never RE-LOCKED it',
      s.seal && s.seal.sealKind !== null && `it left a biolock (${s.seal.sealKind}) — must stay mundane/pickable`,
      s.sealedCount < 1 && 'the boss never counted a seal',
      !s.doorOpen && 'the grenade never breached the door back open',
      s.doorLocked && 'the door is still locked after the breach',
      s.px < 17 && `player never walked through the hole (x=${s.px})`,
      s.gameOver && 'unexpected game over',
    ].filter(Boolean),
})
