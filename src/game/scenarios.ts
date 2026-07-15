// Deterministic demo setups, selected by `?scenario=`. Kept out of the sim
// proper: a scenario just seeds entities into a fresh world before play starts.

import { makeEntity, type Entity } from './entity'
import { isSolidTile } from './levelgen/level'
import { spawnNpc } from './populate'
import { igniteCell } from './systems/fire'
import { addEntity, type World } from './world'

const crate = (w: World, cx: number, cy: number): Entity => {
  const e = makeEntity('interactable', 'crate', cx + 0.5, cy + 0.5, 0.4)
  e.flammable = true
  e.health = { hp: 30, max: 30, iframes: 0 }
  return addEntity(w, e)
}

const openRow = (w: World, x: number, y: number, n: number): boolean => {
  for (let i = 0; i < n; i++) if (isSolidTile(w.level, x + i, y)) return false
  return true
}

/** A run of `n` open cells nearest the level centre — a stage the camera can
 * frame without clamping into a corner. */
const findStage = (w: World, n: number): { x: number; y: number } => {
  const midX = Math.floor(w.level.w / 2)
  const midY = Math.floor(w.level.h / 2)
  let best = { x: Math.floor(w.level.spawn.x), y: Math.floor(w.level.spawn.y) }
  let bestD = Infinity
  for (let y = 1; y < w.level.h - 1; y++) {
    for (let x = 1; x < w.level.w - n; x++) {
      if (!openRow(w, x, y, n)) continue
      const d = Math.abs(x + Math.floor(n / 2) - midX) + Math.abs(y - midY)
      if (d < bestD) {
        bestD = d
        best = { x, y }
      }
    }
  }
  return best
}

/** A row of flammable crates ending in a hapless bystander; the near crate is
 * lit so fire spreads down the row and burns the NPC down. The player watches
 * from just north so the camera centres the blaze. */
const setupFire = (w: World): void => {
  const { x, y } = findStage(w, 7)
  for (let i = 1; i <= 4; i++) crate(w, x + i, y)
  const victim = spawnNpc(w, 'civilian', x + 5 + 0.5, y + 0.5)
  victim.flammable = true
  victim.ai = undefined
  victim.intent = { x: 0, y: 0 }

  const player = w.entities.find((e) => e.playerCtl)
  if (player) {
    const py = isSolidTile(w.level, x + 3, y - 1) ? y : y - 1
    player.pos = { x: x + 3 + 0.5, y: py + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
  }

  igniteCell(w, x + 1, y)
}

export const applyScenario = (w: World, name: string): void => {
  if (name === 'fire') setupFire(w)
}
