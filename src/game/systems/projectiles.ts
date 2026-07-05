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
      e.dead = true
      continue
    }
    for (const other of w.entities) {
      if (other.id === e.projectile.ownerId || other.dead || !other.health) continue
      const dx = other.pos.x - e.pos.x
      const dy = other.pos.y - e.pos.y
      const rr = other.radius + e.radius
      if (dx * dx + dy * dy < rr * rr) {
        applyDamage(w, other, e.projectile.damage, e.pos.x - e.vel.x * SIM_DT, e.pos.y - e.vel.y * SIM_DT, 3, e.projectile.ownerId)
        e.dead = true
        break
      }
    }
  }
}
