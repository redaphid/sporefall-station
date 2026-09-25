/**
 * Reproduction probe for "the freeze mod lets you 2-shot everything, bosses too".
 *
 * Drives the REAL damage path (applyDamage + applyStatus, in the projectile
 * system's order: damage first, then onHit status) and reports shots-to-kill
 * with and without the `frost` mod, for every NPC archetype, every destructible
 * object, and the enemy-on-enemy case.
 *
 *   pnpm exec tsx scripts/test/freeze-shatter-probe.mts
 */
import { NPCS } from '../../src/game/data/npcs'
import { WEAPONS } from '../../src/game/data/items'
import { OBJECTS } from '../../src/game/data/objects'
import { MODS } from '../../src/game/data/mods'
import { spawnNpc } from '../../src/game/populate'
import { applyDamage } from '../../src/game/systems/combat'
import { applyStatus, isFrozen } from '../../src/game/systems/statusFx'
import { statusSystem } from '../../src/game/systems/status'
import { spawnObject } from '../../src/game/systems/objects'
import { createWorld, type World } from '../../src/game/world'
import type { Entity } from '../../src/game/entity'

const PISTOL = WEAPONS.pistol
const FROST = MODS.frost.onHit!

/** One shot through the projectile path's ordering. Advances the world tick by
 * the weapon cooldown so iframes expire exactly as they do in play. */
const shoot = (w: World, e: Entity, dmg: number, frost: boolean): void => {
  const dealt = applyDamage(w, e, dmg, 0, 0, 0, 999)
  if (dealt !== null && frost) applyStatus(w, e, FROST.status, FROST.ticks)
  // Wait out the weapon cooldown through the REAL timer system, so iframes
  // expire and the frost clock advances exactly as they do in play.
  for (let i = 0; i < PISTOL.cooldownTicks; i++) {
    statusSystem(w)
    w.tick++
  }
}

interface Row { shots: number; shattered: boolean; hp: number; frozenAtDeath: boolean }

const killIt = (make: (w: World) => Entity, dmg: number, frost: boolean): Row => {
  const w = createWorld(7, 1)
  const e = make(w)
  const hp = e.health?.hp ?? 0
  let shots = 0
  while (!e.dead && (e.health?.hp ?? 0) > 0 && shots < 10000) {
    shoot(w, e, dmg, frost)
    shots++
  }
  return { shots, shattered: !!e.shattered, hp, frozenAtDeath: isFrozen(e) }
}

const secs = (shots: number): string => (((shots - 1) * PISTOL.cooldownTicks) / 30).toFixed(2)

console.log(`pistol ${PISTOL.damage} dmg / ${PISTOL.cooldownTicks}t; frost onHit = ${FROST.status} ${FROST.ticks}t\n`)

console.log('=== NPC archetypes ===')
console.log('archetype    hp  physRes  plain  frost  gib?  plainTTK  frostTTK')
for (const arch of Object.keys(NPCS)) {
  const plain = killIt((w) => spawnNpc(w, arch, 5, 5), PISTOL.damage, false)
  const fr = killIt((w) => spawnNpc(w, arch, 5, 5), PISTOL.damage, true)
  console.log(
    `${arch.padEnd(11)} ${String(NPCS[arch].hp).padStart(3)} ${String(NPCS[arch].resist?.physical ?? 1).padStart(7)} ` +
      `${String(plain.shots).padStart(6)} ${String(fr.shots).padStart(6)}  ${(fr.shattered ? 'YES' : 'no').padEnd(4)} ` +
      `${secs(plain.shots).padStart(8)}  ${secs(fr.shots).padStart(8)}`,
  )
}

console.log('\n=== destructible objects (can they be frozen/shattered?) ===')
console.log('object          hp  plain  frost  gib?  frozen-at-death?')
for (const id of Object.keys(OBJECTS)) {
  const mk = (w: World): Entity => spawnObject(w, id, 5, 5)!
  let plain: Row, fr: Row
  try {
    plain = killIt(mk, PISTOL.damage, false)
    fr = killIt(mk, PISTOL.damage, true)
  } catch {
    console.log(`${id.padEnd(15)} (not spawnable standalone)`)
    continue
  }
  const flag = fr.shots < plain.shots || fr.shattered ? '  <-- SHATTER REACHES IT' : ''
  console.log(
    `${id.padEnd(15)} ${String(OBJECTS[id].hp).padStart(3)} ${String(plain.shots).padStart(6)} ${String(fr.shots).padStart(6)}  ` +
      `${(fr.shattered ? 'YES' : 'no').padEnd(4)}  ${fr.frozenAtDeath ? 'yes' : 'no'}${flag}`,
  )
}

console.log('\n=== enemy-on-enemy: can an NPC freeze ray + any impact execute another NPC? ===')
{
  const w = createWorld(7, 1)
  const victim = spawnNpc(w, 'boss', 5, 5)
  const shooter = spawnNpc(w, 'thug', 6, 5)
  // NPC freeze ray: 0 damage, onHit frozen 120t (WEAPONS.freezeRay)
  const ray = WEAPONS.freezeRay
  const d = applyDamage(w, victim, ray.damage, 6, 5, 0, shooter.id)
  if (d !== null) applyStatus(w, victim, ray.onHit!.status, ray.onHit!.ticks)
  for (let i = 0; i < 20; i++) { statusSystem(w); w.tick++ }
  console.log(`boss frozen by an NPC freeze ray: ${isFrozen(victim)} (hp ${victim.health!.hp}/${victim.health!.max})`)
  // ...then any other enemy lands a bat swing on it
  const dealt = applyDamage(w, victim, WEAPONS.bat.damage, 6, 5, 0, shooter.id)
  console.log(`after one 16-dmg bat swing from another NPC: dead=${victim.dead} shattered=${!!victim.shattered} reported=${dealt}`)
}
