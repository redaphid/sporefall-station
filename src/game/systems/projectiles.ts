import { SIM_DT } from '../types'
import { isBlocked, type World } from '../world'
import { applyDamage } from './combat'

export const projectileSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.projectile || e.dead) continue
    e.pos.x += e.vel.x * SIM_DT
    e.pos.y += e.vel.y * SIM_DT
    e.projectile.ttl--

    if (e.projectile.ttl <= 0 || isBlocked(w, Math.floor(e.pos.x), Math.floor(e.pos.y))) {
      if (e.projectile.explode) explode(w, e)
      e.dead = true
      continue
    }
    for (const other of w.entities) {
      if (other.id === e.projectile.ownerId || other.dead || !other.health) continue
      const dx = other.pos.x - e.pos.x
      const dy = other.pos.y - e.pos.y
      const rr = other.radius + e.radius
      if (dx * dx + dy * dy < rr * rr) {
        if (e.projectile.explode) {
          explode(w, e)
        } else {
          applyDamage(w, other, e.projectile.damage, e.pos.x - e.vel.x * SIM_DT, e.pos.y - e.vel.y * SIM_DT, 3, e.projectile.ownerId)
        }
        e.dead = true
        break
      }
    }
  }
}

const explode = (w: World, e: { pos: { x: number; y: number }; projectile?: { ownerId: number; explode?: { radius: number; damage: number } } }): void => {
  const boom = e.projectile!.explode!
  w.events.push({ type: 'explosion', x: e.pos.x, y: e.pos.y, radius: boom.radius })
  for (const other of w.entities) {
    if (other.dead || !other.health) continue
    const dist = Math.hypot(other.pos.x - e.pos.x, other.pos.y - e.pos.y)
    if (dist <= boom.radius + other.radius) {
      applyDamage(w, other, boom.damage, e.pos.x, e.pos.y, 10, e.projectile!.ownerId)
    }
  }
}
