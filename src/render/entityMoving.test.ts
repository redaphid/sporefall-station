// Regression: the animator's locomotion signal must come from the per-tick
// displacement (pos - prevPos), NOT from `vel`. The sim's `vel` carries only
// impulses (knockback); input/AI walking integrates straight into `pos`
// (src/game/systems/movement.ts) and leaves `vel` at zero — so an animator
// keyed on vel never enters the walk state for ordinary walking, and every
// walk clip / step flip / procedural gait silently freezes on idle. This bit
// the rotoscoped walk cycles: 40 gated frames shipped and none ever rendered.
// These tests drive the REAL sim and assert on the REAL signal the renderer
// uses, so the semantic link cannot silently regress again.
import { describe, expect, it } from 'vitest'
import { entityMoving, isMoving } from './anim'
import { runTicks } from '../game/testkit'
import { deserializeWorld, type WorldJson } from '../game/serialize'
import combatStage from '../game/__fixtures__/combat-stage.json'
import { SIM_DT } from '../game/types'

const soloStage = (): WorldJson => {
  const w = JSON.parse(JSON.stringify(combatStage)) as WorldJson & {
    entities: Record<string, unknown>[]
  }
  const p = w.entities.find((e) => e.playerCtl)
  if (!p) throw new Error('combat-stage fixture has no player')
  p.pos = { x: 10, y: 11 }
  p.prevPos = { x: 10, y: 11 }
  w.entities = [p]
  return w
}

const player = (w: ReturnType<typeof deserializeWorld>) => w.entities.find((e) => e.playerCtl)!

describe('entityMoving — the walk-state locomotion signal', () => {
  it('a player walking east via real input reads as moving (vel stays ~0)', () => {
    const w = deserializeWorld(soloStage())
    runTicks(w, new Map([[0, { moveX: 1 }]]), 5)
    const p = player(w)
    // The sim moved the player through pos, not vel — the very trap:
    expect(p.pos.x).toBeGreaterThan(10)
    expect(isMoving(p.vel.x, p.vel.y)).toBe(false)
    // …and the displacement-based signal sees the walk.
    expect(entityMoving(p, SIM_DT)).toBe(true)
  })

  it('an idle player reads as NOT moving (no phantom walk cycles)', () => {
    const w = deserializeWorld(soloStage())
    runTicks(w, new Map([[0, {}]]), 5)
    expect(entityMoving(player(w), SIM_DT)).toBe(false)
  })

  it('walking diagonally and stopping: signal drops back to idle the next tick', () => {
    const w = deserializeWorld(soloStage())
    runTicks(w, new Map([[0, { moveX: -1, moveY: 1 }]]), 5)
    expect(entityMoving(player(w), SIM_DT)).toBe(true)
    runTicks(w, new Map([[0, {}]]), 2)
    expect(entityMoving(player(w), SIM_DT)).toBe(false)
  })

  it('sub-epsilon jitter does not read as walking', () => {
    expect(entityMoving({ pos: { x: 5.0004, y: 5 }, prevPos: { x: 5, y: 5 } }, SIM_DT)).toBe(false)
  })

  it('knockback (a pos slide) still animates as movement', () => {
    // vel impulses integrate into pos in the same movement pass, so the
    // displacement signal covers knockback without consulting vel at all.
    const disp = 8 * SIM_DT // 8 tiles/s knockback slide over one tick
    expect(entityMoving({ pos: { x: 5 + disp, y: 5 }, prevPos: { x: 5, y: 5 } }, SIM_DT)).toBe(true)
  })
})
