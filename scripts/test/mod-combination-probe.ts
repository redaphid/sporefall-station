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
