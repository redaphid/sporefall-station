// Bullet AIM DIRECTION — the shot follows the player's CONTINUOUS aim, never a
// compass-quantized 8-way facing. Runs the REAL fire path (movementSystem derives
// facing from the InputCmd's continuous aimX/aimY; combatSystem/fireWeapon spawns
// the projectile along that facing). Adversarial: off-axis angles, a wide sweep,
// determinism across deserialized runs, and degenerate/neutral aim.
//
// Only movementSystem + combatSystem are invoked (never projectileSystem), so a
// bullet's velocity is read at SPAWN — level walls can never eat it and mask the
// heading under test.

import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, type World } from '../world'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { equipSlot } from './inventory'
import { combatSystem } from './combat'
import { movementSystem } from './movement'

const armed = (w: World, x: number, y: number) => {
  const p = spawnPlayer(w, 0, x, y)
  p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 99 }]
  equipSlot(p, 0)
  return p
}

const cmd = (over: Partial<InputCmd>): InputCmd => ({ ...emptyInput(), ...over })

/** Aim at `deg`, fire one shot through the real systems, return the bullet's
 * velocity heading in degrees (or the player facing when no bullet spawned). */
const fireAtAngle = (deg: number): { velDeg: number; faceDeg: number } => {
  const w = createWorld(1, 1)
  const p = armed(w, 20, 20)
  const r = (deg * Math.PI) / 180
  const c = cmd({ aimX: Math.cos(r), aimY: Math.sin(r), attack: true })
  const inputs = new Map([[0, c]])
  movementSystem(w, inputs) // aim → facing (continuous atan2)
  combatSystem(w, inputs) // facing → projectile velocity
  const b = w.entities.find((e) => e.kind === 'projectile')
  const faceDeg = (p.facing * 180) / Math.PI
  if (!b) return { velDeg: NaN, faceDeg }
  return { velDeg: (Math.atan2(b.vel.y, b.vel.x) * 180) / Math.PI, faceDeg }
}

describe('bullet direction follows continuous aim, not 8-way facing', () => {
  it('fires along an OFF-AXIS aim (22.5°) — not snapped to a 45° increment', () => {
    const { velDeg } = fireAtAngle(22.5)
    expect(velDeg).toBeCloseTo(22.5, 4)
    // The nearest 8-way buckets are 0° and 45°; prove we are neither.
    expect(velDeg).not.toBeCloseTo(0, 1)
    expect(velDeg).not.toBeCloseTo(45, 1)
  })

  it('fires along an arbitrary steep angle (100°) exactly', () => {
    expect(fireAtAngle(100).velDeg).toBeCloseTo(100, 4)
  })

  it('an exact 45° diagonal still works (regression guard)', () => {
    expect(fireAtAngle(45).velDeg).toBeCloseTo(45, 4)
  })

  it('a SWEEP of off-axis angles yields distinct, continuous headings (not 8 buckets)', () => {
    const angles = [7, 22.5, 51, 100, 137, 199, 256, 313, 359]
    const vels = angles.map((a) => ((fireAtAngle(a).velDeg + 360) % 360))
    angles.forEach((a, i) => expect(vels[i]).toBeCloseTo(a, 3))
    // Every heading distinct → not collapsed onto a handful of compass buckets.
    expect(new Set(vels.map((v) => Math.round(v * 10))).size).toBe(angles.length)
  })

  it('facing and bullet heading AGREE at every angle (reticle == bullet)', () => {
    for (const a of [13, 68, 149, 231, 300]) {
      const { velDeg, faceDeg } = fireAtAngle(a)
      expect(((velDeg + 360) % 360)).toBeCloseTo((faceDeg + 360) % 360, 4)
    }
  })
})

describe('bullet aim — determinism', () => {
  it('same seed + same aim InputCmd across two deserialized runs → identical world', () => {
    const build = (): World => {
      const base = createWorld(7, 1)
      armed(base, 20, 20)
      // Round-trip through the wire-format serializer so the PRNG stream position
      // and the whole world are set EXACTLY, then run the real fire systems.
      const w = deserializeWorld(serializeWorld(base))
      const c = cmd({ aimX: Math.cos(1.3), aimY: Math.sin(1.3), attack: true })
      const inputs = new Map([[0, c]])
      movementSystem(w, inputs)
      combatSystem(w, inputs)
      return w
    }
    expect(serializeWorld(build())).toEqual(serializeWorld(build()))
  })

  it('an off-axis heading survives a snapshot round-trip bit-for-bit', () => {
    const w = createWorld(3, 1)
    const p = armed(w, 20, 20)
    const c = cmd({ aimX: Math.cos(0.371), aimY: Math.sin(0.371), attack: true })
    const inputs = new Map([[0, c]])
    movementSystem(w, inputs)
    combatSystem(w, inputs)
    const before = serializeWorld(w)
    const after = serializeWorld(deserializeWorld(before))
    expect(after).toEqual(before)
    // And the reconstructed bullet still points where it was aimed.
    const b = deserializeWorld(before).entities.find((e) => e.kind === 'projectile')!
    expect(Math.atan2(b.vel.y, b.vel.x)).toBeCloseTo(0.371, 4)
    expect(p.facing).toBeCloseTo(0.371, 6)
  })
})

describe('bullet aim — degenerate inputs', () => {
  it('neutral aim (no stick) falls back to the last facing without NaN', () => {
    const w = createWorld(1, 1)
    const p = armed(w, 20, 20)
    p.facing = 0.9 // a prior heading
    const inputs = new Map([[0, cmd({ aimX: 0, aimY: 0, attack: true })]])
    movementSystem(w, inputs) // centred aim leaves facing untouched
    combatSystem(w, inputs)
    const b = w.entities.find((e) => e.kind === 'projectile')!
    expect(Number.isNaN(b.vel.x)).toBe(false)
    expect(Number.isNaN(b.vel.y)).toBe(false)
    expect(Math.atan2(b.vel.y, b.vel.x)).toBeCloseTo(0.9, 6)
  })

  it('a tiny sub-deadzone aim nudge does not swing the shot to that micro-angle', () => {
    // Below movement.ts aim threshold (0.01): facing holds, bullet keeps old heading.
    const w = createWorld(1, 1)
    const p = armed(w, 20, 20)
    p.facing = -2.0
    const inputs = new Map([[0, cmd({ aimX: 0.001, aimY: 0.001, attack: true })]])
    movementSystem(w, inputs)
    combatSystem(w, inputs)
    const b = w.entities.find((e) => e.kind === 'projectile')!
    expect(Math.atan2(b.vel.y, b.vel.x)).toBeCloseTo(-2.0, 6)
    expect(p.facing).toBeCloseTo(-2.0, 6)
  })
})
