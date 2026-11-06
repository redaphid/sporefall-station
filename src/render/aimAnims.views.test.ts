// Aiming at the entity layer the game draws with: EntityViews over a real
// createArt registry fed a fake pack whose every frame is its own labelled
// texture, the real sim underneath (animTestkit.aimScene). Reads back which
// frame each sprite shows and where the held weapon sits, tick by tick.

import { describe, expect, it } from 'vitest'
import { DEFAULT_TPF } from './animState'
import { aimScene, fakeArt, shown, trace, type Frame } from './animTestkit'
import { AIM_RAISE, HAND_RIG } from './weaponPose'

const AIM = { aim: 2, aimwalk: 8 }
const run = (clips: Record<string, number>): { player: Frame[]; drowner: Frame[] } => {
  const scene = aimScene()
  const [p, d] = scene.focus
  const t = trace(scene, fakeArt({ player: clips, drowner: clips }))
  return { player: t[p.id], drowner: t[d.id] }
}
/** Index into a trace by the scene's 0-based input tick. */
const at = (frames: Frame[], i: number): Frame => frames[i]
const dirOf = (f: Frame): string => f.tex.split('.')[1]
const weaponXY = (f: Frame): { x: number; y: number } => {
  const [x, y] = f.weapon!.split('@')[1].split(',').map(Number)
  return { x, y }
}

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

describe('without aim frames the held weapon rises from the hip to the raised hold', () => {
  const { player, drowner } = run({})

  it('aiming east: the grip sits at chest height, an arm out along the aim, on every aiming tick', () => {
    const rows = player.slice(0, 200).filter((f) => f.aiming && f.weapon !== null)
    expect(rows.length).toBeGreaterThan(150)
    for (const f of rows) {
      const w = weaponXY(f)
      expect(w.y - f.y, `tick ${f.tick}`).toBeCloseTo(AIM_RAISE.chest, 3)
      // Ranged recoil (≤ 3px back along the aim) is the only other x term.
      const dx = w.x - f.x - (HAND_RIG.e.hx * AIM_RAISE.side + AIM_RAISE.reach)
      expect(dx, `tick ${f.tick}`).toBeLessThanOrEqual(0.001)
      expect(dx, `tick ${f.tick}`).toBeGreaterThanOrEqual(-3.001)
    }
  })

  it('not aiming (wrench): the grip hangs at the hip rig as before', () => {
    const rows = player.slice(205).filter((f) => !f.aiming && f.weapon !== null)
    expect(rows.length).toBeGreaterThan(40)
    for (const f of rows) expect(weaponXY(f).y - f.y).toBeCloseTo(HAND_RIG.s.hy, 3)
  })

  it('the body never shows an aim frame and the drowner keeps its weapon in hand while aiming', () => {
    for (const f of [...player, ...drowner]) expect(shown(f)).not.toMatch(/^aim/)
    const aimed = drowner.filter((f) => f.aiming)
    expect(aimed.length).toBeGreaterThan(20)
    for (const f of aimed) expect(f.weapon).not.toBeNull()
  })
})
