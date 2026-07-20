// Deterministic behavioural proof for the Sporefall mission redesign. Runs the
// REAL sim systems (no mocks) through three access scenarios and writes an
// annotated transcript + the final WorldJson to docs/assets/. Because the sim is
// a pure function of seed + inputs, this transcript is byte-reproducible.
//
//   pnpm exec tsx scripts/test/sporefall-proof.mts
//
// It is a proof, not a unit test — the exhaustive assertions live in
// src/game/systems/sporefall.*.test.ts.

import { mkdirSync, writeFileSync } from 'node:fs'
import { makeEntity, type Entity } from '../../src/game/entity'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { addEntity, createWorld, tickWorld, type World } from '../../src/game/world'
import { serializeWorld } from '../../src/game/serialize'
import { detonate } from '../../src/game/systems/combat'
import { interactionSystem } from '../../src/game/systems/interaction'
import { igniteCell } from '../../src/game/systems/fire'
import { spawnObject, useObject } from '../../src/game/systems/objects'
import { sporeAt } from '../../src/game/systems/spore'

const lines: string[] = []
const log = (s = ''): void => {
  lines.push(s)
}
const interact = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), interact: true }]])
const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const settle = (e: Entity): void => {
  e.prevPos.x = e.pos.x
  e.prevPos.y = e.pos.y
}
const state = (d: Entity): string =>
  d.door!.open ? 'OPEN' : d.door!.overgrown ? `overgrown(hp ${d.door!.growthHp})` : d.door!.locked ? 'SEALED' : 'shut'

log('# Sporefall — "The Living Seal" & "Credentials & Power": behavioural proof')
log('')
log('Real sim systems, driven deterministically (seed + inputs only). Reproduce with')
log('`pnpm exec tsx scripts/test/sporefall-proof.mts`.')
log('')

// ── B: an OVERGROWN hatch burned open ────────────────────────────────────────
log('## B — Overgrown hatch, cleared by FIRE (a molotov on the bog)')
const b: World = createWorld(101, 1, 'normal', false)
const node = spawnObject(b, 'sporeNode', 40, 40) // its Spore Node, kept alive & elsewhere
const bDoor = addEntity(b, makeEntity('door', 'door', 20.5, 20.5, 0.5))
bDoor.door = { open: false, locked: true, lockLevel: 1, overgrown: true, growthHp: 4, nodeId: node.id }
bDoor.flammable = true
bDoor.interact = { verb: 'open', range: 1.3 }
const bp = spawnPlayer(b, 0, 19.6, 20.5)
settle(bp)
log(`tick ${b.tick}: hatch is ${state(bDoor)}; player presses E…`)
interactionSystem(b, interact())
log(`  → ${b.events.map((e) => e.type).join(', ')} (a bare hand can't part the bog)`)
igniteCell(b, 20, 20)
log(`tick ${b.tick}: player lobs a molotov onto the hatch cell — it catches fire.`)
for (let i = 0; i < 60 && bDoor.door!.overgrown; i++) tickWorld(b, idle())
log(`tick ${b.tick}: fire eroded the growth → hatch is ${state(bDoor)}.`)
log('')

// ── B: an overgrown hatch BREACHED ruptures a spore-sac ──────────────────────
log('## B — Overgrown hatch, BREACHED (fast but it ruptures a spore-sac)')
const b2: World = createWorld(102, 1, 'normal', false)
const node2 = spawnObject(b2, 'sporeNode', 40, 40)
const b2Door = addEntity(b2, makeEntity('door', 'door', 20.5, 20.5, 0.5))
b2Door.door = { open: false, locked: true, lockLevel: 1, overgrown: true, growthHp: 8, nodeId: node2.id }
log(`tick ${b2.tick}: hatch is ${state(b2Door)}, alarm=${b2.alarm}. A grenade goes off at the hatch…`)
detonate(b2, 20.5, 20.5, 1.8, 40, 1)
log(`  → hatch ${state(b2Door)}; alarm=${b2.alarm}; spores at the breach = ${sporeAt(b2, 20, 20)}.`)
log('')

// ── A: a KEYCARD biolock ─────────────────────────────────────────────────────
log('## A — Keycard biolock (access is a sub-objective: go get the card)')
const a: World = createWorld(103, 1, 'normal', false)
const ap = spawnPlayer(a, 0, 19.6, 20)
const aDoor = addEntity(a, makeEntity('door', 'door', 20.5, 20, 0.5))
aDoor.door = { open: false, locked: true, lockLevel: 2, sealKind: 'keycard', keyId: 'keycard.north', wing: 'north' }
aDoor.interact = { verb: 'open', range: 1.3 }
settle(ap)
log(`tick ${a.tick}: biolock is ${state(aDoor)}; player presses E with no card…`)
interactionSystem(a, interact())
log(`  → ${a.events.map((e) => e.type).join(', ')}`)
ap.playerCtl!.inventory.push({ itemId: 'keycard.north', qty: 1 })
a.events.length = 0
settle(ap)
log(`tick ${a.tick}: player now HOLDS keycard.north; presses E…`)
interactionSystem(a, interact())
log(`  → ${a.events.map((e) => e.type + ((e as { via?: string }).via ? `(${(e as { via?: string }).via})` : '')).join(', ')}; biolock is ${state(aDoor)}.`)
log('')

// ── A: a POWER biolock, opened by cutting the wing ───────────────────────────
log('## A — Power biolock (cut the wing — a systemic trade-off, not a time-tax)')
const c: World = createWorld(104, 1, 'normal', false)
const cp = spawnPlayer(c, 0, 19.6, 20)
const cDoor = addEntity(c, makeEntity('door', 'door', 20.5, 20, 0.5))
cDoor.door = { open: false, locked: true, lockLevel: 2, sealKind: 'power', wing: 'north' }
cDoor.interact = { verb: 'open', range: 1.3 }
const gen = spawnObject(c, 'generator', 22, 20)
gen.wing = 'north'
settle(cp)
log(`tick ${c.tick}: biolock is ${state(cDoor)}; wing powered (powerCut=${JSON.stringify(c.powerCut)}), alarm=${c.alarm}.`)
useObject(c, cp, gen)
log(`  → hacked the generator: powerCut=${JSON.stringify(c.powerCut)}, alarm=${c.alarm} (the station notices).`)
settle(cp)
interactionSystem(c, idle()) // sealSystem auto-unseals the cut wing
log(`tick ${c.tick}: sealSystem read the outage → biolock is ${state(cDoor)}; player walks through.`)
settle(cp)
interactionSystem(c, interact())
log(`  → biolock is ${state(cDoor)}.`)
log('')

log('## Determinism')
log('Every draw above is a `w.rng.fork(<label>)` / `w.tick` function of the seed; the')
log('new `World.powerCut` field round-trips through serialize.ts (omitted when fully')
log('powered). Snapshot of the power-biolock world after the cut:')
log('')
log('```json')
log(JSON.stringify(serializeWorld(c).powerCut ?? {}, null, 2))
log('```')

const outDir = 'docs/assets'
mkdirSync(outDir, { recursive: true })
const outFile = `${outDir}/sporefall-proof.md`
writeFileSync(outFile, lines.join('\n') + '\n')
// Also drop the final WorldJson for the power scenario, for exact replay.
writeFileSync(`${outDir}/sporefall-proof-world.json`, JSON.stringify(serializeWorld(c), null, 2) + '\n')
console.log(`wrote ${outFile}`)
console.log(lines.join('\n'))
