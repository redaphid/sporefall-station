// A plain scripted player for checking that a crafted scene plays: each tick it
// aims at the nearest live NPC it can see and fires, and walks toward a goal.
// Deterministic in the world it reads, so two runs from one save agree.

import type { Entity } from '../game/entity'
import { canSeeEntity } from '../game/systems/goals'
import { emptyInput, type InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'

export interface BotPlan {
  /** Walk these points in order (world coords), each until within 0.6 tiles of
   * it, then stand on the last. Stand still when absent. */
  route?: readonly { x: number; y: number }[]
  /** Archetypes never shot at (bystanders, props the scene wants left alone). */
  spare?: readonly string[]
  /** Shoot only within this range, tiles. Default 12. */
  range?: number
  /** Prefer these entity ids while they live and are seen. */
  focus?: readonly number[]
  /** Press use on any of these entities while within reach of it, and wait
   * there until it has been used. */
  use?: readonly number[]
}

const player = (w: World): Entity | undefined => w.entities.find((e) => e.playerCtl && !e.dead)

const pickTarget = (w: World, me: Entity, plan: BotPlan): Entity | undefined => {
  const range = plan.range ?? 12
  const seen = (e: Entity): boolean =>
    !e.dead && e.kind === 'npc' && Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y) <= range && canSeeEntity(w, me, e)
  for (const id of plan.focus ?? []) {
    const e = w.byId.get(id)
    if (e && seen(e)) return e
  }
  let best: Entity | undefined
  let bestD = Infinity
  for (const e of w.entities) {
    if (!seen(e) || plan.spare?.includes(e.archetype)) continue
    const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

/** A bot for one run: it remembers how far along its route it has walked. */
export const makeBot = (plan: BotPlan): ((w: World) => InputCmd) => {
  let leg = 0
  return (w) => {
    const cmd = { ...emptyInput(), seq: w.tick }
    const me = player(w)
    if (!me) return cmd
    const target = pickTarget(w, me, plan)
    if (target) {
      const dx = target.pos.x - me.pos.x
      const dy = target.pos.y - me.pos.y
      const len = Math.hypot(dx, dy) || 1
      cmd.aimX = dx / len
      cmd.aimY = dy / len
      cmd.attack = true
    }
    const usable = (plan.use ?? []).some((id) => {
      const e = w.byId.get(id)
      return e && !e.dead && !(e.door ? e.door.open : e.used) && Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y) < 1.2
    })
    // `interact` is edge-triggered: press on even ticks, release on odd.
    cmd.interact = usable && w.tick % 2 === 0
    const route = plan.route ?? []
    // Beside something still to use, hold the leg until it has been used.
    while (!usable && leg < route.length - 1 && Math.hypot(route[leg].x - me.pos.x, route[leg].y - me.pos.y) < 0.6) leg++
    const goal = route[leg]
    if (goal) {
      const dx = goal.x - me.pos.x
      const dy = goal.y - me.pos.y
      const len = Math.hypot(dx, dy)
      if (len > 0.2) {
        cmd.moveX = dx / len
        cmd.moveY = dy / len
      }
    }
    return cmd
  }
}

/** Run a bot as player 0 for `n` ticks. */
export const runBot = (w: World, n: number, plan: BotPlan): World => {
  const bot = makeBot(plan)
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, bot(w)]]))
  return w
}
