// Deterministic proof of the boss-door aggro escalation: boot a real floor whose
// mission tagged an objective gateway, snapshot every NPC's disposition + AI
// mode BEFORE, breach the gate with a grenade, tick once, and print the AFTER —
// showing the whole floor flip Hostile/aggro. Pure sim (seed + inputs), so the
// dump is byte-identical on every run and machine.
// Usage: pnpm exec tsx scripts/test/boss-door-aggro-proof.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tickWorld, createWorld, type World } from '../../src/game/world' // FIRST: breaks the world↔ai↔goals cycle under tsx
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { setupFloor } from '../../src/game/systems/missions'
import { detonate } from '../../src/game/systems/combat'
import { dispositionToward } from '../../src/game/systems/relationships'
import { emptyInput } from '../../src/game/types'

const boot = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return w
}

// First seed/floor with a tagged objective door and live NPCs.
let w: World | undefined
let where = ''
for (let seed = 1; seed <= 300 && !w; seed++) {
  for (const floor of [2, 3, 5, 6]) {
    const cand = boot(seed, floor)
    if (cand.mission.objectiveDoorId !== undefined && cand.entities.some((e) => e.ai && !e.dead)) {
      w = cand
      where = `seed=${seed} floor=${floor} template=${cand.mission.template}`
      break
    }
  }
}
if (!w) throw new Error('no suitable floor found')

const player = w.entities.find((e) => e.playerCtl)!
const door = w.byId.get(w.mission.objectiveDoorId!)!
const npcs = (): typeof w.entities => w!.entities.filter((e) => e.ai && !e.playerCtl && !e.dead)
const tally = (): Record<string, number> => {
  const t: Record<string, number> = { Friendly: 0, Neutral: 0, Annoyed: 0, Hostile: 0, aggro: 0 }
  for (const n of npcs()) {
    t[dispositionToward(n, player.id)]++
    if (n.ai!.mode === 'aggro') t.aggro++
  }
  return t
}

const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}

log(`# Boss-door aggro proof — ${where}`)
log(`objective gate: door #${door.id} at (${door.pos.x},${door.pos.y}) locked=${door.door!.locked} objectiveGate=${door.door!.objectiveGate}`)
log(`NPCs on floor: ${npcs().length}   alarm=${w.alarm}   bossAggroTriggered=${!!w.mission.bossAggroTriggered}`)
log(`BEFORE breach — dispositions ${JSON.stringify(tally())}`)

log(`\n>> detonate a grenade ON the objective gate (player #${player.id}) …`)
detonate(w, door.pos.x, door.pos.y, 1.8, 40, player.id)
tickWorld(w, new Map([[0, emptyInput()]]))

log(`AFTER breach  — alarm=${w.alarm}   bossAggroTriggered=${!!w.mission.bossAggroTriggered}`)
log(`AFTER breach  — dispositions ${JSON.stringify(tally())}`)
log(`events this tick: ${w.events.map((e) => e.type).join(', ')}`)
const t = tally()
log(`\nRESULT: ${t.Hostile}/${npcs().length} NPCs Hostile, ${t.aggro}/${npcs().length} aggro, alarm ${w.alarm}/3 — ${
  t.Hostile === npcs().length && t.aggro === npcs().length && w.alarm === 3 ? 'FLOOR FULLY HOSTILE ✓' : 'INCOMPLETE ✗'
}`)

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../docs/assets')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'boss-door-aggro-proof.txt'), lines.join('\n') + '\n')
