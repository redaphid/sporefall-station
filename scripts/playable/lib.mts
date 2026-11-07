// Shared bits for the playable-scenario world generators in this directory
// (one `<id>.mts` per authored world in src/playable/entries/). Each draws its
// rows, stages a cast and calls `save(id, w)`, which writes
// src/game/__fixtures__/<id>.json: the world ships in the bundle and plays at
// `?play=<id>`. Run one: `pnpm exec tsx scripts/playable/<id>.mts`.

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnPlayer } from '../../src/game/player'
import { spawnNpc } from '../../src/game/populate'
import type { Entity } from '../../src/game/entity'
import { worldFromState, type World } from '../../src/game/world'
import { Sketch, arm, writeSave } from '../saves/lib.mts'

export { Sketch, arm, writeSave as save }

/** A world on these rows, the player on the `@` tile with `hp` max hp. */
export const stage = (rows: string[], opts: { seed?: number; hostile?: boolean; hp?: number } = {}): { w: World; p: Entity } => {
  const w = worldFromState({ level: levelFromJson({ rows }), seed: opts.seed ?? 1106, hostile: opts.hostile ?? true })
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  if (opts.hp && p.health) p.health = { ...p.health, hp: opts.hp, max: opts.hp }
  return { w, p }
}

/** Put an NPC on tile (tx, ty)'s centre. */
export const npc = (w: World, archetype: string, tx: number, ty: number): Entity => spawnNpc(w, archetype, tx + 0.5, ty + 0.5)

/** Asleep where it stands, facing (fx, fy): a target that waits to be shot. */
export const asleep = (e: Entity, fx: number, fy: number, hp?: number): Entity => {
  e.status = { stun: 0, hitFlashUntil: 0, cloakUntil: 0, ...e.status, sleep: 100000 }
  if (e.ai) e.ai.home = { x: e.pos.x, y: e.pos.y }
  e.facing = Math.atan2(fy - e.pos.y, fx - e.pos.x)
  if (hp !== undefined && e.health) e.health.hp = hp
  return e
}

/** A walled rectangle of `floor`, `w` x `h` tiles, with `@` at (sx, sy). */
export const room = (w: number, h: number, sx: number, sy: number, floor = '.'): Sketch =>
  new Sketch(w, h, '#').fill(1, 1, w - 2, h - 2, floor).put(sx, sy, '@')
