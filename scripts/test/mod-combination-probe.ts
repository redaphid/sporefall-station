// COMBINATIONS — the core mechanic, measured.
//
// Verifies the claims a combination table would rest on, through the real fold
// and the real fire path. Anything asserted in the design writeup should be
// reproducible here.
//
//   npx tsx scripts/test/mod-combination-probe.ts

import { MODS } from '../../src/game/data/mods'
import { NPCS } from '../../src/game/data/npcs'
import { WEAPONS } from '../../src/game/data/items'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { applyModPickup } from '../../src/game/systems/inventory'
import { addStatus } from '../../src/game/systems/statusFx'
import { resolveWeapon } from '../../src/game/systems/resolveWeapon'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'
import type { Entity } from '../../src/game/entity'

const TPS = 30
const SEEDS = [11, 22, 33, 44, 55]

// ── 1. Can two elements even coexist? ──────────────────────────────────────
// `resolveWeapon` keeps ONE `onHit` slot and the fold overwrites it in sorted-id
// order, so the alphabetically-last elemental silently wins and the other pick
// contributes nothing. If true, "combine two elements" is not expressible.
console.log('=== 1. ELEMENTAL EXCLUSIVITY — can two elements combine at all? ===')
const stack = (...ids: string[]) => ({ itemId: 'pistol', qty: 1, mods: ids.map((id) => ({ id, stacks: 1 })) })
for (const combo of [['frost'], ['incendiary'], ['shock'], ['frost', 'incendiary'], ['frost', 'shock'], ['incendiary', 'shock'], ['frost', 'incendiary', 'shock']]) {
  const rw = resolveWeapon(WEAPONS.pistol, stack(...combo).mods)
  console.log(`  ${combo.join(' + ').padEnd(30)} -> onHit = ${rw.onHit ? rw.onHit.status : 'none'}`)
}
console.log('  (one onHit slot: the alphabetically LAST elemental wins; the others are inert)\n')

// ── 2. Which behaviours are silently cancelled by `explosive`? ─────────────
console.log('=== 2. DEAD COMBOS — what does `explosive` silently cancel? ===')
console.log('  projectiles.ts checks p.explode FIRST and terminates the bullet, so')
console.log('  pierce / split / lifesteal / onHit / detonator never run on a direct hit.')
const ex = resolveWeapon(WEAPONS.pistol, stack('explosive', 'pierce', 'lifesteal', 'incendiary').mods)
console.log(`  resolved: pierce=${ex.behavior.pierce} lifesteal=${ex.behavior.lifestealFrac.toFixed(2)} onHit=${ex.onHit?.status} explodeR=${ex.behavior.explodeRadius}`)
console.log('  ^ all present in the RESOLVED weapon, so the fold cannot warn you —')
console.log('    they are dropped at runtime, invisibly.\n')

// ── 3. Live-fire TTK for candidate combinations ────────────────────────────
const placeNear = (w: World, arch: string, sx: number, sy: number): Entity | undefined => {
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 0], [-2, 0], [0, 2], [0, -2], [4, 0], [-4, 0]] as const) {
    const e = spawnNpc(w, arch, sx + dx, sy + dy)
    if (e) return e
  }
  return undefined
}

const ttk = (arch: string, mods: string[], seed: number): number | undefined => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p) return undefined
  for (const m of mods) applyModPickup(p, m)
  const foe = placeNear(w, arch, sp.x, sp.y)
  if (!foe || !foe.health) return undefined
  for (let t = 0; t < 90 * TPS; t++) {
    if (foe.dead || !foe.health || foe.health.hp <= 0) return t / TPS
    const dx = foe.pos.x - p.pos.x, dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    if (p.health) { p.health.hp = 1_000_000; p.health.max = 1_000_000 }
    const cmd: InputCmd = { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }
    tickWorld(w, new Map([[0, cmd]]))
  }
  return undefined
}

const median = (arch: string, mods: string[]): string => {
  const xs: number[] = []
  for (const s of SEEDS) { const v = ttk(arch, mods, s); if (v !== undefined) xs.push(v) }
  if (!xs.length) return ' >90s'
  xs.sort((a, b) => a - b)
  return `${xs[Math.floor(xs.length / 2)].toFixed(2)}s`.padStart(6)
}

const COMBOS: [string, string[]][] = [
  ['(bare pistol)', []],
  ['frost', ['frost']],
  ['heavy', ['heavy']],
  ['frost + heavy', ['frost', 'heavy']],
  ['frost + overload', ['frost', 'overload']],
  ['incendiary', ['incendiary']],
  ['incendiary + rapid', ['incendiary', 'rapid']],
  ['bulk', ['bulk']],
  ['bulk + choke', ['bulk', 'choke']],
  ['bulk + incendiary', ['bulk', 'incendiary']],
  ['pierce + bulk', ['pierce', 'bulk']],
  ['explosive', ['explosive']],
  ['explosive + bulk', ['explosive', 'bulk']],
  ['explosive + pierce (DEAD)', ['explosive', 'pierce']],
  ['splinterShot + frost', ['splinterShot', 'frost']],
  ['overload x2', ['overload', 'overload']],
]

console.log('=== 3. LIVE-FIRE TTK BY COMBINATION (median of 5 seeds) ===')
console.log(`combination                     ${['thug', 'robot', 'brute', 'boss'].map((s) => s.padStart(7)).join('')}`)
for (const [label, mods] of COMBOS) {
  const row = ['thug', 'robot', 'brute', 'boss'].map((a) => median(a, mods)).map((s) => s.padStart(7)).join('')
  console.log(`${label.padEnd(30)}  ${row}`)
}

// ── 3b. FROST AFTER THE BRITTLE SPLIT — does the payoff respect the stat block? ──
// The old rule shattered ANY frozen non-player: hp = 0, no hp/resist/archetype
// check. Every archetype therefore died at the same wall-clock time no matter how
// big its pool was. If the column below is flat again, an HP-independent effect
// has come back.
console.log('\n=== 3b. FROST SWEEP — does the frost payoff scale with HP? ===')
console.log('enemy      hp   resist.phys    no mod     frost')
for (const arch of ['thug', 'robot', 'brute', 'boss']) {
  const def = NPCS[arch]
  const hp = String(def?.hp ?? '?').padStart(4)
  const rp = (def?.resist?.physical ?? 1).toFixed(2).padStart(9)
  console.log(`${arch.padEnd(9)}${hp}${rp}      ${median(arch, [])}    ${median(arch, ['frost'])}`)
}

// ── 6. WHAT A SHATTER STILL TRIGGERS ───────────────────────────────────────
// The blocked-hit fix made `applyDamage` return TRUE on a shatter ("a shatter IS
// a landed blow"). That is right in principle, but it means every on-hit effect
// now fires on an instant kill. This section measures exactly which ones do, and
// whether any of them double-dips.
//
// The same script runs on the PRE-FIX tree: there, `addStatus` has no `brittle`
// parameter, the extra argument is ignored, and EVERY freeze shatters — so the
// "brittle=false" rows below reproduce the old behaviour and the contrast is
// visible without editing anything.
console.log('\n=== 6. WHAT A SHATTER STILL TRIGGERS (on-hit effects on an instant kill) ===')

interface ShotResult {
  weapon: string
  bulletDamage: number
  healed: number
  dealt: number
  shattered: boolean
  killed: boolean
  explosions: number
  frozenAfter: boolean
  brittleWasSet: boolean
}

/** Pre-freeze `arch`, fire until the first blow lands on it, and report what that
 * single blow did. Drives the REAL fire path (combatSystem → projectileSystem →
 * applyDamage), so the lifesteal/status/trigger gating measured here is the
 * gating the game actually uses. */
const frozenShot = (mods: string[], ice: 'none' | 'plain' | 'brittle', arch = 'brute'): ShotResult | undefined => {
  const w = createWorld(7, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p?.health) return undefined
  for (const m of mods) applyModPickup(p, m)
  const foe = placeNear(w, arch, sp.x, sp.y)
  if (!foe?.health) return undefined

  // Room to heal into: lifesteal clamps at max, so a full-health owner hides it.
  p.health.max = 1000
  p.health.hp = 100
  // Freeze the body BEFORE the shot so the blow resolves through the frozen
  // branch. `brittle` is the 6th arg; on the pre-fix tree it is simply dropped,
  // which is exactly what makes the same script reproduce the old behaviour.
  if (ice !== 'none') addStatus(w, foe, 'frozen', 900, undefined, ice === 'brittle')
  const brittleWasSet = foe.fx?.frozen?.brittle === true

  const weapon = p.combat?.weapon ?? '?'
  const bulletDamage = resolveWeapon(WEAPONS[weapon] ?? WEAPONS.pistol, p.loadout?.inventory?.[0]?.mods).damage
  const hpBefore = p.health.hp
  const foeBefore = foe.health.hp
  let explosions = 0

  for (let t = 0; t < 200; t++) {
    const dx = foe.pos.x - p.pos.x, dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }]]))
    explosions += w.events.filter((e: { type: string }) => e.type === 'explosion').length
    const hit = w.events.some((e) => (e.type === 'hit' && (e as { targetId?: number }).targetId === foe.id) || (e.type === 'shatter' && (e as { entityId?: number }).entityId === foe.id))
    if (hit || foe.dead) {
      return {
        weapon, bulletDamage, brittleWasSet,
        healed: p.health.hp - hpBefore,
        dealt: foeBefore - (foe.health?.hp ?? 0),
        shattered: foe.shattered === true,
        killed: foe.dead === true || (foe.health?.hp ?? 1) <= 0,
        explosions,
        frozenAfter: foe.fx?.frozen !== undefined,
      }
    }
  }
  return undefined
}

const show = (label: string, r: ShotResult | undefined): void => {
  if (!r) { console.log(`  ${label.padEnd(34)} — no hit resolved`); return }
  console.log(
    `  ${label.padEnd(34)} shattered=${String(r.shattered).padEnd(5)} killed=${String(r.killed).padEnd(5)}` +
    ` dealt=${r.dealt.toFixed(1).padStart(6)} healed=${r.healed.toFixed(2).padStart(6)}` +
    ` boom=${r.explosions} stillFrozen=${r.frozenAfter}`,
  )
}

{
  const probe = frozenShot(['lifesteal'], 'brittle')
  console.log(`  (starter weapon ${probe?.weapon ?? '?'}, bullet damage ${probe?.bulletDamage ?? '?'}, target brute)`)
  console.log(`  (brittle flag actually set on the ice: ${probe?.brittleWasSet ?? false} —`)
  console.log('   if FALSE you are on the pre-fix tree and every row below shatters)')
  console.log('')
  console.log('  --- THE HYPOTHESIS: does lifesteal fire on an instant kill? ---')
  show('lifesteal + BRITTLE ice (grenade)', probe)
  show('lifesteal + plain ice (Cryo Rounds)', frozenShot(['lifesteal'], 'plain'))
  show('lifesteal + NO ice (true control)', frozenShot(['lifesteal'], 'none'))
  console.log('   If `healed` is identical across all three, the shatter grants no EXTRA')
  console.log('   heal — lifesteal reads the BULLET\'s damage, so neither the execute nor')
  console.log('   the x2.5 crack amplifies it. Compare `dealt` to see the crack land.')
  console.log('')
  console.log('  --- do kill-triggers chain off a shatter? ---')
  show('detonator + BRITTLE ice', frozenShot(['detonator'], 'brittle'))
  show('detonator + plain ice', frozenShot(['detonator'], 'plain'))
  show('detonator + NO ice', frozenShot(['detonator'], 'none'))
  console.log('   `boom` must be at most 1: a shatter is one kill, so the on-kill trigger')
  console.log('   fires once. A 2 here would mean the shatter double-counted the kill.')
  console.log('')
  console.log('  --- does the on-hit element re-apply to a shattered corpse? ---')
  show('frost + BRITTLE ice', frozenShot(['frost'], 'brittle'))
  show('frost + plain ice', frozenShot(['frost'], 'plain'))
  show('frost + NO ice', frozenShot(['frost'], 'none'))
}

// ── 7. LIFESTEAL ON ITS OWN TERMS ──────────────────────────────────────────
// Independent of frost and of shatter: a mod that nets positive health on every
// landed hit makes the player unkillable through ordinary play, no exploit
// needed. Two things are measured here.
//
//   (a) WHERE THE NUMBER COMES FROM. projectiles.ts heals `p.damage * frac` —
//       the bullet's INTENDED damage, never the amount applyDamage actually
//       subtracted. Against an armoured body the heal therefore overpays by
//       exactly 1/resist. Measured below as an overpay ratio per archetype.
//   (b) SUSTAIN. Heal throughput in hp/sec at 1 and 5 stacks, against the
//       damage a body of each archetype can put back into you.
console.log('\n=== 7. LIFESTEAL ON ITS OWN TERMS (independent of frost/shatter) ===')

console.log('  (a) heal vs damage ACTUALLY dealt — the overpay is 1/resist.physical')
console.log('  enemy      resist   dealt/hit   healed/hit   heal as % of damage dealt')
for (const arch of ['thug', 'robot', 'brute', 'boss']) {
  const r = frozenShot(['lifesteal'], 'none', arch)
  if (!r) { console.log(`  ${arch.padEnd(10)} — no hit resolved`); continue }
  const pct = r.dealt > 0 ? (r.healed / r.dealt) * 100 : 0
  console.log(
    `  ${arch.padEnd(10)}${(NPCS[arch]?.resist?.physical ?? 1).toFixed(2).padStart(6)}` +
    `${r.dealt.toFixed(1).padStart(11)}${r.healed.toFixed(2).padStart(13)}${`${pct.toFixed(0)}%`.padStart(20)}`,
  )
}

/** Heal throughput: fire continuously at an unkillable body and count hp gained
 * per second. The owner is held below max so nothing clamps. */
const healRate = (stacks: number, arch: string, seconds = 8): number | undefined => {
  const w = createWorld(13, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p?.health) return undefined
  for (let i = 0; i < stacks; i++) applyModPickup(p, 'lifesteal')
  const foe = placeNear(w, arch, sp.x, sp.y)
  if (!foe?.health) return undefined
  p.health.max = 10_000_000
  let healed = 0
  for (let t = 0; t < seconds * TPS; t++) {
    foe.health.hp = foe.health.max // unkillable: measure throughput, not TTK
    const before = p.health.hp
    const dx = foe.pos.x - p.pos.x, dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }]]))
    const delta = p.health.hp - before
    if (delta > 0) healed += delta // gains only; incoming damage is counted separately
    p.health.hp = 1000 // re-seat well below max so the clamp never bites
  }
  return healed / seconds
}

console.log('\n  (b) heal THROUGHPUT while firing (hp/sec, target unkillable)')
console.log('  target        1 stack    5 stacks')
for (const arch of ['thug', 'brute']) {
  const one = healRate(1, arch)
  const five = healRate(5, arch)
  console.log(`  ${arch.padEnd(12)}${(one?.toFixed(2) ?? '  n/a').padStart(8)}    ${(five?.toFixed(2) ?? 'n/a').padStart(8)}`)
}
console.log('  Compare against what a body puts back into you: if heal/sec exceeds the')
console.log('  incoming dps of the things you are shooting, the run cannot be lost.')

// ── 4. Does lifesteal heal off blocked (i-framed) hits? ────────────────────
console.log('\n=== 4. LIFESTEAL vs I-FRAMES — does it heal on hits that dealt no damage? ===')
console.log(`  IFRAME window is 5 ticks; a bulk volley lands ${'many'} pellets in ONE tick.`)
{
  const w = createWorld(9, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  const foe = placeNear(w, 'brute', sp.x, sp.y)
  if (p && foe && p.health && foe.health) {
    for (const m of ['lifesteal', 'bulk', 'bulk']) applyModPickup(p, m)
    p.health.hp = 10
    const foeBefore = foe.health.hp
    const pBefore = p.health.hp
    for (let t = 0; t < 40; t++) {
      const dx = foe.pos.x - p.pos.x, dy = foe.pos.y - p.pos.y
      const len = Math.hypot(dx, dy) || 1
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }]]))
    }
    console.log(`  player healed ${(p.health.hp - pBefore).toFixed(1)} hp while dealing ${(foeBefore - foe.health.hp).toFixed(1)} damage`)
    console.log('  Was 23.5 healed / 12.0 dealt — heal ran on pellets i-frames had voided, so the')
    console.log('  build outhealed its own output. The heal is now gated on applyDamage landing.')
    console.log('  RESIDUAL (by design, flagging not fixing): the heal is still a fraction of the')
    console.log('  bullet\'s INTENDED damage, not the resisted amount, so it overpays against')
    console.log('  armoured targets. Bounded and small; changing it is a balance decision.')
  }
}

// ── 5. Rarity / reachability of every mod ──────────────────────────────────
console.log('\n=== 5. THE ROSTER ===')
for (const m of Object.values(MODS)) {
  console.log(`  ${m.icon} ${m.id.padEnd(14)} ${m.category.padEnd(9)} ${m.rarity.padEnd(10)} maxStacks=${m.maxStacks ?? 5}`)
}
console.log(`\n  archetypes: ${Object.keys(NPCS).join(', ')}`)
