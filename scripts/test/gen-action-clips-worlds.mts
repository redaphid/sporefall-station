// Worlds for the in-game proof of the first drawn action clips (e2e/feature-action-clips.mjs):
//   drowner-draw   three drowners on patrol at 3 tiles from the player, west, north-west and north,
//                  so their first sight of the player is an engage seen in e, se and s: the 8-frame
//                  `draw` plays, then the first shot lands NpcDef.drawTicks (16) after the engage.
//   hound-fidget   three gloam-hounds standing calm, facing e, ne and w (w is e mirrored), brains
//                  parked so nothing pulls them out of idle: each scratches on its own fidget grid.
// Deterministic: the committed combat-stage map (seed + floor), spawnNpc's real archetype rows, ids
// fixed by the world's nextId. Writes src/game/__fixtures__/action-<name>.json.
//
//   pnpm exec tsx scripts/test/gen-action-clips-worlds.mts

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnNpc } from '../../src/game/populate'
import { deserializeWorld, serializeWorld, type WorldJson } from '../../src/game/serialize'

const dir = fileURLToPath(new URL('../../src/game/__fixtures__/', import.meta.url))
const base = JSON.parse(readFileSync(`${dir}combat-stage.json`, 'utf8')) as WorldJson
const CX = 10
const CY = 11

const stage = (place: (w: ReturnType<typeof deserializeWorld>) => void, name: string): void => {
  const w = deserializeWorld(base)
  const p = w.entities.find((e) => e.playerCtl)!
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = Math.PI / 2
  w.entities = [p]
  place(w)
  writeFileSync(`${dir}action-${name}.json`, JSON.stringify(serializeWorld(w), null, 2) + '\n')
  console.log(`action-${name}: ${w.entities.length} entities`)
}

stage((w) => {
  for (const [dx, dy] of [[-3, 0], [-2.1, -2.1], [0, -3]] as const) {
    const d = spawnNpc(w, 'drowner', CX + dx, CY + dy)
    d.facing = Math.atan2(-dy, -dx)
  }
}, 'drowner-draw')

stage((w) => {
  for (const [dx, dy, face] of [[-2.5, 1.5, 0], [0, -2.5, -Math.PI / 4], [2.5, 1.5, Math.PI]] as const) {
    const h = spawnNpc(w, 'gloamhound', CX + dx, CY + dy)
    h.facing = face
    h.ai!.thinkAt = 1e9 // calm for the whole clip: no hunt, no wander
  }
}, 'hound-fidget')
