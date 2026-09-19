// The stair system (docs/design/stairs-and-storeys.md §3.2): a live, standing
// player on a stair tile moves to the landing on the other storey. Runs right
// after movementSystem so the climb lands on the tick the step does — the same
// tick the client's prediction (netClient.stepSelf, same `stairStep`) does.
//
// Phase 1: only players take the stairs. NPCs, projectiles, pickups and props
// never transit; a body knocked onto a stair tile just stands on it.

import { bodySpawnPoint } from '../spawnPlacement'
import { vlen } from '../simMath'
import { stairStep, storeyZ } from '../stairs'
import type { World } from '../world'

export const stairSystem = (w: World): void => {
  const level = w.level
  if (!level.stairs) return
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead) continue
    if (e.playerCtl.downed) {
      // A downed body neither climbs nor keeps a stale lock.
      continue
    }
    const r = stairStep(level, e.pos.x, e.pos.y, e.stairLock === true)
    if (r.link) {
      // Arrive on the landing; if a body already stands there, the nearest
      // free tile centre on the same storey (never a stair tile).
      const occupied = (x: number, y: number): boolean =>
        level.stairs!.some((l) => l.from.x === Math.floor(x) && l.from.y === Math.floor(y)) ||
        w.entities.some((o) => o !== e && !o.dead && (o.kind === 'player' || o.kind === 'npc' || o.kind === 'interactable') && vlen(o.pos.x - x, o.pos.y - y) < o.radius + e.radius)
      const at = bodySpawnPoint(level, r.x, r.y, e.radius, occupied) ?? { x: r.x, y: r.y }
      e.pos.x = at.x
      e.pos.y = at.y
      e.prevPos.x = at.x
      e.prevPos.y = at.y
      e.vel.x = 0
      e.vel.y = 0
      w.events.push({ type: 'storeyChange', entityId: e.id, z: storeyZ(level, at.x), x: at.x, y: at.y })
    }
    if (r.locked) e.stairLock = true
    else if (e.stairLock) delete e.stairLock
  }
}
