// The status-effect shader grammar — the SINGLE SOURCE OF TRUTH that turns a
// character's active status set (`Entity.fx`: burning/frozen/wet/electrified/
// poisoned, and any future status like `spore`) PLUS the weapon+mods that
// applied it into the FLOAT UNIFORMS that drive the per-character GPU shaders
// (statusShaders.ts). The look of each effect is modulated by these floats:
//   electrified → uShock  (scales with stacked `shock` / Tesla mods)
//   burning     → uBurn   (scales with stacked `incendiary` mods)
//   frozen      → uFrost  (scales with stacked `frost` / Cryo mods)
//   poisoned    → uPoison
//   wet         → uWet
// So a gun with three Tesla mods lights its victims up brighter than a bare
// pistol's stray zap — the player literally reads their build ON the enemy.
//
// Pure module: no pixi, no DOM, no RNG. A total function of (fx, the mod list
// that drove each status). It unit-tests exhaustively and — because the shader
// animates purely off the sim tick + a per-entity seed — host, client and
// replay derive byte-identical uniforms. Unknown/new status ids fall back to a
// sensible miasma effect (never crash, never attach a broken filter), so the
// incoming `spore` status composes safely before its sim branch even lands.

import type { WeaponMod } from '../game/entity'
import { modPickupColor } from './modColors'

/** Shader-side effect selector (aData.x in statusShaders.ts). Keep in sync. */
export const EFFECT = { lightning: 0, fire: 1, frost: 2, poison: 3, wet: 4 } as const
export type EffectKind = keyof typeof EFFECT

/** One status id's shader mapping: which fragment branch draws it, which weapon
 * mod (if any) amplifies it, and its canonical hue when no such mod drove it
 * (e.g. an NPC's bare-weapon proc, or a status with no matching mod). */
export interface StatusShaderDef {
  effect: EffectKind
  /** The mod id whose stack count scales this status's intensity. Absent = the
   * status has no amplifying mod (wet/poison), so it always shows at base. */
  mod?: string
  /** Canonical hue used when no driving mod is present (0xRRGGBB). */
  color: number
}

/**
 * status id → shader mapping. The classic five are declared; `spore` is declared
 * DEFENSIVELY (a parallel sim branch is adding it) so it reads as a bubbling
 * green miasma the moment it exists — but any id absent here still resolves via
 * FALLBACK, so a brand-new status is never a crash or a blank.
 */
export const STATUS_SHADERS: Record<string, StatusShaderDef> = {
  electrified: { effect: 'lightning', mod: 'shock', color: 0xbcd8ff },
  burning: { effect: 'fire', mod: 'incendiary', color: 0xff6a1a },
  frozen: { effect: 'frost', mod: 'frost', color: 0x9fe0ff },
  poisoned: { effect: 'poison', color: 0x8cff5a },
  wet: { effect: 'wet', color: 0x5aa8ff },
  spore: { effect: 'poison', color: 0x9cff6a },
}

/** The look any UNKNOWN status id gets: a neutral miasma so an unrecognised
 * effect is still visible and legible rather than crashing or drawing nothing. */
export const STATUS_FALLBACK: StatusShaderDef = { effect: 'poison', color: 0x9aa0b0 }

/** Base intensity a status shows at with NO amplifying mod (bare proc / NPC). */
export const STATUS_BASE = 0.5

const clamp01p = (n: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(0, n)) : 0)

/** RoR2-style saturating accumulation — approaches but never reaches 1 however
 * many stacks pile on, so a monster build stays bright-but-bounded. Strictly
 * increasing in `sum`, which keeps intensity MONOTONIC in stack count. */
const saturating = (sum: number): number => 1 - 1 / (1 + Math.max(0, sum))

/** How fast each mod stack pushes a status toward full intensity. */
const STACK_GAIN = 0.6

/**
 * Intensity a status shows: BASE when nothing amplifies it, rising toward 1 as
 * the driving mod stacks. Total and monotonic — 0 stacks → BASE, and every
 * added stack strictly increases the result (never past 1).
 */
export const statusIntensity = (stacks: number): number => {
  const s = Number.isFinite(stacks) ? Math.max(0, Math.floor(stacks)) : 0
  return STATUS_BASE + (1 - STATUS_BASE) * saturating(s * STACK_GAIN)
}

/** Total stacks of `modId` on a resolved mod list. 0 if absent. The list is
 * already sim-capped (pickup enforces modMaxStacks), so no re-clamp here — and
 * `saturating` bounds the output anyway, keeping a degenerate stack finite. */
const stacksOf = (mods: readonly WeaponMod[] | undefined, modId: string): number => {
  if (!mods) return 0
  let n = 0
  for (const m of mods) if (m.id === modId) n += Math.max(0, Math.floor(m.stacks))
  return n
}

/** One character's on-screen status quad: which effect branch, how intense, its
 * hue, and the status id it came from (for change-detection/debug). */
export interface StatusQuad {
  statusId: string
  effect: number
  /** 0..1 look intensity — the per-status FLOAT uniform (uShock/uBurn/…). */
  intensity: number
  color: number
}

/** The canonical named float uniforms (0 when the status is absent) — the values
 * the tests and debug surface read. Every field is finite and >= 0. */
export interface StatusUniforms {
  shock: number
  burn: number
  frost: number
  poison: number
  wet: number
}

export interface StatusComposition {
  /** Named float uniforms for the five classic statuses. */
  uniforms: StatusUniforms
  /** One quad per ACTIVE shader-status (empty ⇒ attach nothing). */
  quads: StatusQuad[]
  /** Overall energy 0..1 (max active intensity) — scales the glow/quad size. */
  energy: number
  /** The dominant active status's hue, or 0 when none. */
  color: number
}

const ZERO_UNIFORMS = (): StatusUniforms => ({ shock: 0, burn: 0, frost: 0, poison: 0, wet: 0 })

/** Which named uniform a status id feeds (only the classic five). */
const UNIFORM_KEY: Record<string, keyof StatusUniforms> = {
  electrified: 'shock',
  burning: 'burn',
  frozen: 'frost',
  poisoned: 'poison',
  wet: 'wet',
}

/**
 * Compose a character's status shader state. Pure and total:
 *  - no active statuses (undefined/empty fx) → all-zero uniforms + no quads, so
 *    the renderer attaches nothing at all;
 *  - each active status maps to its effect (unknown ids → FALLBACK miasma),
 *    intensity rising monotonically with its driving mod's stack count on the
 *    weapon that applied it, hue = that mod's pickup colour (or the status's
 *    canonical hue when no such mod drove it);
 *  - multiple statuses compose independently — one quad each, named uniforms set
 *    side by side.
 *
 * @param fx          the character's active status map (`Entity.fx`).
 * @param resolveMods source-entity-id → that applier's live weapon mod list.
 *                    Returns undefined for NPCs / bare fists → base intensity.
 */
export const composeStatus = (
  fx: Record<string, { until: number; source?: number }> | undefined,
  resolveMods: (source: number | undefined) => readonly WeaponMod[] | undefined,
): StatusComposition => {
  const uniforms = ZERO_UNIFORMS()
  const quads: StatusQuad[] = []
  if (!fx) return { uniforms, quads, energy: 0, color: 0 }

  let energy = 0
  let color = 0
  // Sorted ids: composition is independent of object key order (replay-stable).
  for (const statusId of Object.keys(fx).sort()) {
    const def = STATUS_SHADERS[statusId] ?? STATUS_FALLBACK
    const mods = resolveMods(fx[statusId]?.source)
    const stacks = def.mod ? stacksOf(mods, def.mod) : 0
    const intensity = clamp01p(statusIntensity(stacks), 1)
    const hue = def.mod && stacks > 0 ? modPickupColor(def.mod) : def.color
    quads.push({ statusId, effect: EFFECT[def.effect], intensity, color: hue })
    const key = UNIFORM_KEY[statusId]
    if (key) uniforms[key] = intensity
    if (intensity > energy) {
      energy = intensity
      color = hue
    }
  }
  return { uniforms, quads, energy, color }
}
