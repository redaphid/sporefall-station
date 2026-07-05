import type { World } from '../world'

/** Decrements all per-tick timers: stun, sleep, iframes, weapon/ability cooldowns. */
export const statusSystem = (w: World): void => {
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.status) {
      if (e.status.stun > 0) e.status.stun--
      if (e.status.sleep > 0) e.status.sleep--
    }
    if (e.health && e.health.iframes > 0) e.health.iframes--
    if (e.combat && e.combat.cooldown > 0) e.combat.cooldown--
    if (e.playerCtl && e.playerCtl.abilityCooldown > 0) e.playerCtl.abilityCooldown--
  }
}
