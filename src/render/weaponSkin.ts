// The held-weapon MOD SKIN — how applied weapon mods mutate the LOOK of the
// weapon in the wielder's hand (a different visual layer from the projectile
// look in bulletVisuals.ts: this is the weapon itself, not the shot). The tint
// is keyed off the SAME source of truth as the mod-pickup diamonds —
// `modPickupColor` (modColors.ts) — so a frost-modded weapon wears the exact
// cyan of the frost gem, and a kid reads "that's a frost weapon" at a glance.
//
// Pure & total: no pixi, no DOM, no RNG — a function of the mod list only, so
// host/client/replay derive the identical skin and it unit-tests exhaustively.
// Multiple mods COMPOSE (blended tint, accumulating size/glow), never switch to
// one preset, and every field is clamped so a monster build stays legible.

import { MODS, modMaxStacks } from '../game/data/mods'
import type { WeaponMod } from '../game/entity'
import { modPickupColor } from './modColors'

/** The composed look of one held weapon. */
export interface WeaponSkin {
  /** Sprite tint (0xRRGGBB). 0xffffff = the bare weapon's own colours. */
  tint: number
  /** Size multiplier (1 = base). Grows a little with total stack power. */
  scale: number
  /** Additive glow halo strength 0..1 (0 = no glow pass). */
  glow: number
  /** Glow halo tint — the dominant mod hue. */
  glowColor: number
  /** Total effective stacks — "how modded is this weapon" scalar. */
  power: number
}

/** The vanilla (no-mod) skin: the weapon's own art, untinted, no glow. */
export const baseWeaponSkin = (): WeaponSkin => ({
  tint: 0xffffff,
  scale: 1,
  glow: 0,
  glowColor: 0xffffff,
  power: 0,
})

const SCALE_MAX = 1.35
const GLOW_MAX = 0.85

const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
const hex = (r: number, g: number, b: number): number =>
  (Math.round(Math.max(0, Math.min(255, r))) << 16) |
  (Math.round(Math.max(0, Math.min(255, g))) << 8) |
  Math.round(Math.max(0, Math.min(255, b)))

/** Approaches but never reaches `max` however many contributions stack. */
const saturating = (sum: number, max: number): number => max * (1 - 1 / (1 + sum))

/**
 * Compose a held weapon's skin from its applied mods. Pure and total: unknown
 * ids and non-positive stacks are skipped, stacks floor + cap at the registry
 * maxStacks, and mods are folded in sorted-id order so the result is independent
 * of pick/attach order. No mods → the untinted base skin.
 */
export const composeWeaponSkin = (mods: readonly WeaponMod[] | undefined): WeaponSkin => {
  const skin = baseWeaponSkin()
  if (!mods || mods.length === 0) return skin

  const active = [...mods]
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .map((m) => ({ id: m.id, stacks: Math.min(Math.floor(m.stacks), modMaxStacks(m.id)) }))
    .filter((m) => m.stacks > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (active.length === 0) return skin

  // Stack-weighted blend of each mod's pickup colour (the diamond palette).
  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  let power = 0
  let topWeight = -1
  let dominant = 0xffffff
  for (const { id, stacks } of active) {
    const color = modPickupColor(id)
    const [cr, cg, cb] = rgb(color)
    // Per-stack taper (sqrt) so the first stack matters most — matches the
    // bullet-trait compounding so weapon and shot read as the same build.
    const w = Math.sqrt(stacks)
    r += cr * w
    g += cg * w
    b += cb * w
    weight += w
    power += stacks
    if (w > topWeight) {
      topWeight = w
      dominant = color
    }
  }

  skin.tint = weight > 0 ? hex(r / weight, g / weight, b / weight) : 0xffffff
  skin.scale = Math.min(SCALE_MAX, 1 + power * 0.05)
  skin.glow = saturating(power * 0.5, GLOW_MAX)
  skin.glowColor = dominant
  skin.power = power
  return skin
}
