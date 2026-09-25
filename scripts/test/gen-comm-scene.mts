// Regenerate the committed `comm-scene` world fixture — a small, STATIC tableau
// used by the annotation/selection screenshot e2e (e2e/comm-ui.mjs). A player is
// ringed by a few NPCs (clustered close so their engine-positioned labels crowd
// and exercise de-overlap), plus a pickup to inspect. Every NPC is put to a long
// sleep so the scene holds still for deterministic screenshots (a sleeping NPC is
// skipped by aiSystem, so nothing wanders or attacks during capture).
//
// Run: npx tsx scripts/test/gen-comm-scene.mts

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Entity } from '../../src/game/entity'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { serializeWorld } from '../../src/game/serialize'
import { createWorld } from '../../src/game/world'

const SEED = 20260715
const w = createWorld(SEED, 1)

// Anchor the tableau at a point that stays near screen centre under the camera's
// edge clamp (halfW≈20, halfH≈11.25 tiles at 1280×720/zoom-1), independent of the
// level's actual corner spawn — so every clustered entity is reliably on-screen.
const A = { x: 20, y: 11 }
spawnPlayer(w, 0, A.x, A.y)

// Clustered close so their engine-positioned labels crowd and exercise de-overlap.
const npcs: Entity[] = [
  spawnNpc(w, 'cop', A.x + 2, A.y - 2),
  spawnNpc(w, 'thug', A.x - 2, A.y - 2),
  spawnNpc(w, 'gangster', A.x + 3, A.y + 1),
  spawnNpc(w, 'thug', A.x, A.y - 3),
]
// Freeze every NPC: a long sleep makes aiSystem skip them (no move, no attack).
for (const e of npcs) e.status = { stun: 0, sleep: 100000, hitFlashUntil: 0, cloakUntil: 0 }

// A pickup to point a pin at and to inspect. Was a medkit until the item cull
// removed every consumable; it is now a grenade, and it carries the PROPER
// `pickup.<id>` archetype (the old bare 'medkit' string was never in the wire
// ARCHETYPES list at all, so kindOf/art had to guess at it).
const pick = spawnNpc(w, 'thug', A.x - 3, A.y + 2) // reuse spawn plumbing, then reshape
pick.kind = 'pickup'
pick.archetype = 'pickup.grenade'
delete pick.ai
delete pick.combat
delete pick.health
pick.status = undefined
pick.pickup = { itemId: 'grenade', qty: 1 }
pick.interact = { verb: 'pickup', range: 0.8 }

const dir = fileURLToPath(new URL('../../src/game/__fixtures__/', import.meta.url))
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}comm-scene.json`, JSON.stringify(serializeWorld(w), null, 2) + '\n')
console.log('wrote comm-scene.json to', dir)
