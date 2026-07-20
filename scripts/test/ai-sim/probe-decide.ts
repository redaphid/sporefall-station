// Analytic probes of the pure decision function — no sim noise, just `decide()`
// evaluated over controlled inputs. Isolates two structural weaknesses:
//   A. No hysteresis at the battle/flee crossover (#59): a 1-hp jitter at the
//      boundary flips the goal every evaluation.
//   B. NPCs never target other NPCs: the `threat` consideration only iterates
//      players, so the whole faction/sworn-enemy matrix is inert for autonomy.

import { addNpc, addPlayer, center, decide, makeArena } from './arena'

// ── A. Battle/flee crossover has no deadband ────────────────────────────────
console.log('== A. battle/flee crossover (gangster, hunter brain, hostile world) ==')
{
  const w = makeArena(1)
  const c = center(w)
  addPlayer(w, c.x, c.y)
  const g = addNpc(w, 'gangster', c.x + 6, c.y, { sight: 12 })
  const max = g.health!.max
  let prev = ''
  let flips = 0
  const boundary: number[] = []
  for (let hp = max; hp >= 1; hp--) {
    g.health!.hp = hp
    const goal = decide(w, g).goal.code
    if (prev && goal !== prev) {
      flips++
      boundary.push(hp)
    }
    prev = goal
  }
  console.log(`  max=${max}  decision flips across full hp sweep: ${flips} at hp=${boundary.join(',')}`)
  // Show the per-tick jitter: hp bouncing +/-1 around the boundary flips every tick.
  const b = boundary[0] ?? Math.round(max / 3)
  const seq: string[] = []
  for (const hp of [b + 1, b, b + 1, b, b + 1, b]) {
    g.health!.hp = hp
    seq.push(`${hp}:${decide(w, g).goal.code}`)
  }
  console.log(`  a regen/dot 1-hp oscillation at the boundary -> ${seq.join('  ')}`)
  console.log('  => zero deadband: the goal (and thus movement) reverses every evaluation.\n')
}

// ── B. NPC-vs-NPC autonomy is dead ──────────────────────────────────────────
console.log('== B. sworn enemies never engage without a player ==')
{
  const w = makeArena(2)
  const c = center(w)
  const cop = addNpc(w, 'cop', c.x, c.y, { sight: 14, weapon: 'pistol' })
  const gang = addNpc(w, 'gangster', c.x + 4, c.y, { sight: 14, weapon: 'pistol' })
  // Sworn enemies (initialFactionHate cop<->gang = 5 = Hostile), in plain sight.
  const copGoal = decide(w, cop).goal
  const gangGoal = decide(w, gang).goal
  console.log(`  cop sees gangster 4 tiles away  -> goal=${copGoal.code} target=${copGoal.target ?? '-'}`)
  console.log(`  gangster sees cop 4 tiles away  -> goal=${gangGoal.code} target=${gangGoal.target ?? '-'}`)
  console.log('  => both WANDER. `threat` only scans entities with playerCtl, so the')
  console.log('     faction/sworn-enemy matrix drives no autonomous NPC combat.\n')
}

// ── C. Spore/environment is invisible to the brain ──────────────────────────
console.log('== C. the brain reads no environmental/spore signal ==')
console.log('  grep: no consideration references w.noises beyond `investigate`, none reads')
console.log('  spore cells, fire, wet, light, or corpses. Theme hazards are pure DOT.')
