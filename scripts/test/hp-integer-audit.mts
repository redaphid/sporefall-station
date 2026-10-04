// Audit: run every `?scenario=` for 900 ticks with the player at half hp,
// alternating 150 ticks of fire at the nearest NPC in sight within 8 tiles with 150 of
// rest, and report any entity whose hp is not whole. A player with no NPC in
// sight gets a training dummy two tiles away (`dummy` in the row). `lifesteal-hits`
// counts ticks where the player's lifesteal carry moved; a scenario that arms
// the player with lifesteal but lands none is flagged UNEXERCISED.
// Exits 1 on any fractional hp or unexercised lifesteal kit.
// Run: pnpm exec tsx scripts/test/hp-integer-audit.mts
import { makeEntity, type Entity } from '../../src/game/entity'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { applyScenario, SCENARIO_NAMES } from '../../src/game/scenarios'
import { playerSpawnPoint } from '../../src/game/spawnPlacement'
import { weaponStack } from '../../src/game/systems/inventory'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { addEntity, createWorld, isBlocked, tickWorld, type World } from '../../src/game/world'

/** Clear line from a to b, and close enough for a pistol round to reach. */
const inSight = (w: World, a: Entity, b: Entity): boolean => {
  const dist = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y)
  if (dist > 8) return false
  for (let s = 0; s <= dist; s += 0.25) {
    const x = a.pos.x + ((b.pos.x - a.pos.x) * s) / dist
    const y = a.pos.y + ((b.pos.y - a.pos.y) * s) / dist
    if (isBlocked(w, Math.floor(x), Math.floor(y))) return false
  }
  return true
}

const isFoe = (e: Entity): boolean => e.kind === 'npc' && !e.dead && !!e.health

/** Put a 100000 hp dummy two tiles from the player in the first clear
 * direction, unless an NPC is already in sight. Returns whether it did. */
const ensureTarget = (w: World): boolean => {
  const p = w.entities.find((e) => e.playerCtl && !e.dead)
  if (!p || w.entities.some((e) => isFoe(e) && inSight(w, p, e))) return false
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const dummy = makeEntity('npc', 'civilian', p.pos.x + dx * 2, p.pos.y + dy * 2)
    if (!inSight(w, p, dummy)) continue
    dummy.health = { hp: 100000, max: 100000, iframes: 0 }
    addEntity(w, dummy)
    return true
  }
  return false
}

let bad = 0
for (const name of SCENARIO_NAMES) {
  const w = createWorld(3, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  applyScenario(w, name)
  for (const e of w.entities) if (e.playerCtl && e.health) e.health.hp = Math.floor(e.health.max / 2)
  const dummy = ensureTarget(w)
  const armed = w.entities.some((e) => e.playerCtl && weaponStack(e)?.mods?.some((m) => m.id === 'lifesteal'))
  let first: string | undefined
  let fractional = 0
  let lifestealHits = 0
  let menderHeals = 0
  for (let t = 0; t < 900; t++) {
    const p = w.entities.find((e) => e.playerCtl && !e.dead)
    const d2 = (e: Entity): number => (p ? (e.pos.x - p.pos.x) ** 2 + (e.pos.y - p.pos.y) ** 2 : 0)
    const foe = p && w.entities.filter((e) => isFoe(e) && inSight(w, p, e)).sort((a, b) => d2(a) - d2(b))[0]
    const dx = foe && p ? foe.pos.x - p.pos.x : 1
    const dy = foe && p ? foe.pos.y - p.pos.y : 0
    const len = Math.hypot(dx, dy) || 1
    const carry = p?.health?.lifestealCarry
    const firing = Math.floor(t / 150) % 2 === 0
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: firing, aimX: dx / len, aimY: dy / len }]]))
    if (p?.health && p.health.lifestealCarry !== carry) lifestealHits++
    menderHeals += w.events.filter((ev) => ev.type === 'heal').length
    for (const e of w.entities) {
      if (!e.health || Number.isInteger(e.health.hp)) continue
      fractional++
      first ??= `tick ${w.tick} ${e.archetype}#${e.id} hp=${e.health.hp}/${e.health.max}`
    }
  }
  const unexercised = armed && lifestealHits === 0
  const verdict = fractional ? 'FRACTIONAL ' : unexercised ? 'UNEXERCISED' : 'ok         '
  console.log(`${verdict} ${name.padEnd(16)} fractional-samples=${fractional} lifesteal-hits=${lifestealHits} mender-heals=${menderHeals}${dummy ? ' dummy' : ''}${first ? `  first: ${first}` : ''}`)
  if (fractional || unexercised) bad++
}
console.log(bad ? `${bad} scenario(s) failed the audit` : 'every scenario kept hp whole')
if (bad) process.exitCode = 1
