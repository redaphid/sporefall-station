/** (a) Does renderView() throw when `self` resolves to a non-player entity?
 *  (b) How fast does world.nextId climb toward the u16 wire ceiling (65535)? */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'
import { applyWireEntity, kindOf } from '../../src/net/protocol/messages'

// ---- (a) the crash mechanism, on the real client code path -----------------
// Mimic exactly what netClient.renderView() does at lines 471-478.
const fakeSelfFromWire = (archetype: string) =>
  applyWireEntity(undefined, { id: 7, archetype, x: 1, y: 1, facing: 0, hpPct: 1, flags: 0 }, 0)

for (const arch of ['player', 'boss', 'thug', 'table']) {
  const self: any = fakeSelfFromWire(arch)
  const hud = { cash: 5, weapon: 'pistol', abilityCd: 0, bandages: 0, briefcase: false }
  let threw: string | null = null
  try {
    // VERBATIM netClient.ts:472-477
    self.playerCtl!.cash = hud.cash
    self.playerCtl!.abilityCooldown = hud.abilityCd
    if (self.combat) self.combat.weapon = hud.weapon
    else self.combat = { weapon: hud.weapon, cooldown: 0 }
  } catch (e) { threw = (e as Error).message }
  console.log(`archetype=${arch.padEnd(7)} kind=${kindOf(arch).padEnd(12)} playerCtl=${self.playerCtl ? 'yes' : 'NO '} renderViewThrows=${threw ?? 'no'}`)
}

// ---- (b) entity-id growth --------------------------------------------------
const w = createWorld(20260808, 1, 'normal')
populateWorld(w); setupFloor(w)
for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
for (const e of w.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
console.log(`\nnextId after floor 1 build: ${w.nextId}`)
let simTicks = 0
for (let floor = 2; floor <= 10; floor++) {
  for (let t = 0; t < 900; t++) { tickWorld(w, inputs); simTicks++ }   // 30s of play per floor
  nextFloor(w)
  for (const e of w.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  console.log(`  after floor ${floor} (${(simTicks / 30 / 60).toFixed(1)} min played): nextId=${w.nextId}  (u16 ceiling 65535)`)
}
