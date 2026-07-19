// The distortion-primitive layer under the backbuffer pipeline (backbuffer.ts):
// a small pooled set of screen-space displacement sources — shockwave rings
// (explosions), heat shimmer (fire cells / doused-burn steam), refraction
// pulses (impacts, deep-stack rounds in flight) and kaleidoscopic bloom cores
// (explosion centres, fractal pass) — all summed by ONE composite shader pass.
//
// Pure module: no pixi, no DOM, no RNG. Prims are spawned from sim events and
// entity state, and every animated quantity derives from the tick counter and
// an id/position hash — so host, client and replay pack byte-identical
// uniforms, and the pool unit-tests exhaustively.

import type { Entity } from '../game/entity'
import type { SimEvent } from '../game/types'
import { composeBulletTraits } from './bulletVisuals'

export type DistortionKind = 'shockwave' | 'shimmer' | 'refraction' | 'bloom'

/** Shader-side kind indices (uPrimB[i].x). Keep in sync with backbuffer.ts. */
export const KIND_INDEX: Record<DistortionKind, number> = { shockwave: 0, shimmer: 1, refraction: 2, bloom: 3 }

/** Hard cap on simultaneously-live primitives — the shader loop bound. */
export const MAX_PRIMS = 16

export interface DistortionSpec {
  kind: DistortionKind
  /** Centre, world tiles. */
  x: number
  y: number
  /** Max extent, world tiles. */
  radius: number
  /** 0..1 displacement/bloom weight. */
  strength: number
  /** Stable 0..1 phase seed (from ids/coords — never RNG). */
  seed: number
  /** Total life in ticks (drives the age ramp). */
  life: number
  /** Sustained prims (fire cells, in-flight rounds) refresh by key each tick
   * instead of stacking duplicates; keyless prims are one-shots. */
  key?: string
}

export interface DistortionPrim extends DistortionSpec {
  bornTick: number
  expireTick: number
}

/** Deterministic 0..1 hash of an integer — the same recipe family as
 * bullets.ts hash01, so flicker/phase is replayable everywhere. */
export const seedHash = (n: number): number => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  return ((h >>> 16) & 0xffff) / 0x10000
}

/** Seed for a positioned event (explosions carry no entity id). */
const posSeed = (x: number, y: number, tick: number): number =>
  seedHash((Math.round(x * 8) * 73 + Math.round(y * 8) * 179 + tick * 37) | 0)

/**
 * The live-primitive pool. Cap MAX_PRIMS: spawning past the cap evicts the
 * soonest-to-expire prim (deterministic — ties break on lowest slot), so a
 * grenade barrage keeps the newest, longest-lived waves. Keyed prims refresh
 * in place (position/strength/expiry) and keep their original bornTick so the
 * animation phase never restarts mid-life.
 */
export class DistortionPool {
  private prims: DistortionPrim[] = []

  /** Live prims, spawn order. Read-only view — do not mutate. */
  list(): readonly DistortionPrim[] {
    return this.prims
  }

  spawn(spec: DistortionSpec, tick: number): void {
    if (spec.key !== undefined) {
      const live = this.prims.find((p) => p.key === spec.key)
      if (live) {
        live.x = spec.x
        live.y = spec.y
        live.radius = spec.radius
        live.strength = spec.strength
        live.expireTick = tick + spec.life
        return
      }
    }
    const prim: DistortionPrim = { ...spec, bornTick: tick, expireTick: tick + spec.life }
    if (this.prims.length >= MAX_PRIMS) {
      let victim = 0
      for (let i = 1; i < this.prims.length; i++) {
        if (this.prims[i].expireTick < this.prims[victim].expireTick) victim = i
      }
      this.prims.splice(victim, 1)
    }
    this.prims.push(prim)
  }

  /** Drop expired prims. Call once per sim tick before packing. */
  update(tick: number): void {
    this.prims = this.prims.filter((p) => p.expireTick > tick)
  }

  clear(): void {
    this.prims = []
  }
}

/** Map one tick's sim events to primitive spawns. Pure — same events, same
 * tick → the same spec list, in event order. */
export const specsForEvents = (events: readonly SimEvent[], tick: number): DistortionSpec[] => {
  const out: DistortionSpec[] = []
  for (const ev of events) {
    if (ev.type === 'explosion') {
      const seed = posSeed(ev.x, ev.y, tick)
      // The pressure wave travels well past the damage radius…
      out.push({ kind: 'shockwave', x: ev.x, y: ev.y, radius: ev.radius * 2.4 + 1.2, strength: 1, seed, life: 20 })
      // …and the core blooms a brief kaleidoscopic fractal (fractal pass).
      out.push({ kind: 'bloom', x: ev.x, y: ev.y, radius: ev.radius * 1.5 + 0.6, strength: 1, seed, life: 26 })
    } else if (ev.type === 'shatter') {
      out.push({ kind: 'refraction', x: ev.x, y: ev.y, radius: 1.2, strength: 0.6, seed: seedHash(ev.entityId), life: 12 })
    } else if (ev.type === 'shock') {
      out.push({ kind: 'refraction', x: ev.x, y: ev.y, radius: 1.0, strength: 0.5, seed: seedHash(ev.targetId), life: 10 })
    } else if (ev.type === 'hit') {
      out.push({ kind: 'refraction', x: ev.x, y: ev.y, radius: 0.7, strength: 0.3, seed: seedHash(ev.targetId), life: 8 })
    } else if (ev.type === 'burnDoused') {
      // Stop-drop-and-roll steam: a hot shimmer puff where the burn quenched.
      out.push({ kind: 'shimmer', x: ev.x, y: ev.y, radius: 1.4, strength: 0.8, seed: seedHash(ev.entityId), life: 30 })
    }
  }
  return out
}

/** Mod-stack power at which an in-flight round starts warping air around it —
 * the same threshold that unlocks chroma in bulletVisuals. */
const DEEP_STACK_POWER = 3

/**
 * Sustained, entity-tracked prims — refreshed by key every tick while their
 * source lives, expiring a beat after it disappears:
 *  - fire cells shimmer (heat haze over every burning tile),
 *  - deep-stack rounds (power ≥ 3 — the chroma tier) drag a refraction pulse.
 * The trait→uniform bridge: strength scales off the composed bullet traits.
 */
export const sustainedSpecs = (entities: readonly Entity[]): DistortionSpec[] => {
  const out: DistortionSpec[] = []
  for (const e of entities) {
    if (e.dead) continue
    if (e.kind === 'fire' && e.fire) {
      out.push({
        kind: 'shimmer',
        x: e.pos.x,
        y: e.pos.y,
        radius: 1.1,
        strength: 0.55,
        seed: seedHash(e.id),
        life: 60,
        key: `fire:${e.id}`,
      })
    } else if (e.kind === 'projectile' && e.archetype === 'projectile' && e.projectile?.mods) {
      const traits = composeBulletTraits(e.projectile.mods)
      if (traits.power >= DEEP_STACK_POWER) {
        out.push({
          kind: 'refraction',
          x: e.pos.x,
          y: e.pos.y,
          radius: 0.9,
          strength: Math.min(0.5, 0.18 + (traits.power - DEEP_STACK_POWER) * 0.08),
          seed: seedHash(e.id),
          life: 45,
          key: `proj:${e.id}`,
        })
      }
    }
  }
  return out
}

/** World-tile → screen-uv projector, injected by the renderer (derived from the
 * live camera transform, so it needs no duplicated math here). */
export interface UvProjector {
  /** World tiles → normalized screen uv (0..1 on-screen; may run outside). */
  toUv(x: number, y: number): { x: number; y: number }
  /** World-tile length → uv units of SCREEN HEIGHT (shader distances are
   * measured in height units; aspect is corrected shader-side). */
  radiusToUv(r: number): number
}

/** Margin (uv units) past the screen edge before a prim is culled from the pack. */
const CULL_MARGIN = 0.25

/**
 * Pack the pool into the composite shader's uniform arrays. Layout per prim i:
 *   uPrimA[i] = (u, v, radiusUv, age01)          — age01 = raw life fraction
 *   uPrimB[i] = (kindIndex, strength, seed, env) — env = in/out envelope
 * Returns the packed count; untouched slots keep stale data but sit past the
 * count, and the shader loop breaks before reading them. No allocation: the
 * caller owns the arrays. Deterministic: pool state + time + projector fully
 * decide every float.
 */
export const packPrims = (
  pool: DistortionPool,
  time: number,
  proj: UvProjector,
  outA: Float32Array,
  outB: Float32Array,
): number => {
  let n = 0
  for (const p of pool.list()) {
    if (n >= MAX_PRIMS) break
    const uv = proj.toUv(p.x, p.y)
    const r = proj.radiusToUv(p.radius)
    if (uv.x < -CULL_MARGIN - r || uv.x > 1 + CULL_MARGIN + r) continue
    if (uv.y < -CULL_MARGIN - r || uv.y > 1 + CULL_MARGIN + r) continue
    const age = Math.min(1, Math.max(0, (time - p.bornTick) / p.life))
    // Envelope: ramp in over ~6 ticks, ramp out over the last 6 before expiry.
    // Keyed (sustained) prims keep expiry pushed ahead, so env holds at 1.
    const ageIn = Math.min(1, (time - p.bornTick) / 6)
    const ageOut = Math.min(1, Math.max(0, (p.expireTick - time) / 6))
    const env = Math.min(ageIn, ageOut)
    outA[n * 4 + 0] = uv.x
    outA[n * 4 + 1] = uv.y
    outA[n * 4 + 2] = r
    outA[n * 4 + 3] = age
    outB[n * 4 + 0] = KIND_INDEX[p.kind]
    outB[n * 4 + 1] = p.strength
    outB[n * 4 + 2] = p.seed
    outB[n * 4 + 3] = env
    n++
  }
  return n
}
