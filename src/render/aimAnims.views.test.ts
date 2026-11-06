// Aiming at the entity layer the game draws with: EntityViews over a real
// createArt registry fed a fake pack whose every frame is its own labelled
// texture, the real sim underneath (animTestkit.aimScene). Reads back which
// frame each sprite shows and whether the held weapon shows, tick by tick.
// Where a held weapon sits is weapon v2's (heldWeapon.views.test.ts).

import { describe, expect, it } from 'vitest'
import { DEFAULT_TPF } from './animState'
import { aimScene, fakeArt, fakeWeapons, shown, trace, type Frame } from './animTestkit'

const AIM = { aim: 2, aimwalk: 8 }
const run = (clips: Record<string, number>, weapons = true): { player: Frame[]; drowner: Frame[] } => {
  const scene = aimScene()
  const [p, d] = scene.focus
  const t = trace(scene, fakeArt({ player: clips, drowner: clips }, {}, {}, weapons ? fakeWeapons() : undefined))
  return { player: t[p.id], drowner: t[d.id] }
}
/** Index into a trace by the scene's 0-based input tick. */
const at = (frames: Frame[], i: number): Frame => frames[i]
const dirOf = (f: Frame): string => f.tex.split('.')[1]

describe('aim frames at the entity layer', () => {
  const { player, drowner } = run(AIM)

  it('the player stands in aim.0/aim.1 at tpf 12, the gun drawn by the frames (held sprite stowed)', () => {
    for (let i = 2; i < 40; i++) {
      expect(shown(at(player, i)), `i ${i}`).toMatch(/^aim\.[01]$/)
      expect(at(player, i).weapon).toBeNull()
    }
    const holds = player.slice(2, 40).map(shown)
    expect(new Set(holds).size).toBe(2)
  })

  it('strafing north and backpedalling west it cycles aimwalk.0..7 facing east, every frame un-mirrored', () => {
    for (let i = 42; i < 120; i++) {
      const f = at(player, i)
      expect(shown(f), `i ${i}`).toMatch(/^aimwalk\.[0-7]$/)
      expect(dirOf(f), `i ${i}`).toBe('e')
      expect(f.sx, `i ${i}`).toBeGreaterThan(0)
      expect(f.weapon).toBeNull()
    }
    // Same cadence as walk: one frame per DEFAULT_TPF.aimwalk ticks, all eight seen.
    const run = player.slice(42, 120).map(shown)
    expect(new Set(run).size).toBe(8)
    let changes = 0
    for (let k = 1; k < run.length; k++) if (run[k] !== run[k - 1]) changes++
    expect(changes).toBeGreaterThanOrEqual(Math.floor(run.length / DEFAULT_TPF.aimwalk) - 1)
  })

  it('backpedalling: the sprite travels west while it faces east', () => {
    expect(at(player, 118).x).toBeLessThan(at(player, 82).x)
    expect(dirOf(at(player, 100))).toBe('e')
  })

  it('a wrench in hand: walk frames and the held sprite at the hip, never aim', () => {
    for (let i = 202; i < 260; i++) {
      const f = at(player, i)
      expect(shown(f), `i ${i}`).not.toMatch(/^aim/)
      expect(f.weapon).not.toBeNull()
    }
  })

  it('the drowner draws nothing it lacks: it aims only from its wind-up end, and while aiming shows no held sprite', () => {
    const aimed = drowner.filter((f) => /^aim/.test(shown(f)))
    expect(aimed.length).toBeGreaterThan(20)
    for (const f of aimed) expect(f.weapon).toBeNull()
    for (const f of drowner) if (f.ghost) expect(shown(f)).not.toMatch(/^aim/)
  })
})

describe('without aim frames the body walks and idles and keeps the held weapon in hand', () => {
  const { player, drowner } = run({})

  it('the body never shows an aim frame, and on every aiming tick the held sprite shows', () => {
    for (const f of [...player, ...drowner]) expect(shown(f)).not.toMatch(/^aim/)
    const aimed = [...player, ...drowner].filter((f) => f.aiming && !f.ghost)
    expect(aimed.length).toBeGreaterThan(150)
    for (const f of aimed) expect(f.weapon, `tick ${f.tick}`).not.toBeNull()
  })

  it('not aiming (wrench): the held sprite shows too', () => {
    const rows = player.slice(205).filter((f) => !f.aiming)
    expect(rows.length).toBeGreaterThan(40)
    for (const f of rows) expect(f.weapon).not.toBeNull()
  })
})

describe('a pack with no weapon art draws no held weapon, aiming or not', () => {
  const { player, drowner } = run({}, false)

  it('no frame of either body carries a held sprite', () => {
    expect(player.some((f) => f.aiming)).toBe(true)
    for (const f of [...player, ...drowner]) expect(f.weapon).toBeNull()
  })
})
