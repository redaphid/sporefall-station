import { makeEntity, type Entity } from '../entity'
import { addEntity, type World } from '../world'

export interface ClassDef {
  id: string
  name: string
  hp: number
  speed: number
  startWeapon: string
  abilityName: string
  abilityCooldownTicks: number
  /** Host-authoritative; mutates the world and emits events only. */
  ability(w: World, self: Entity): boolean
  meleeDamageMult?: number
}

const GRENADE_FUSE_TICKS = 24

/** Soldier is the ONLY playable class — there is no class-selection step; every
 * player (solo, host, and joining clients) spawns as a soldier. `spawnPlayer`
 * also falls back to soldier for any unknown classId, so stale ids from old
 * URLs or peers degrade safely. */
export const CLASSES: Record<string, ClassDef> = {
  soldier: {
    id: 'soldier',
    name: 'Soldier',
    hp: 120,
    speed: 4.5,
    startWeapon: 'pistol',
    abilityName: 'Grenade',
    abilityCooldownTicks: 8 * 30,
    meleeDamageMult: 1.25,
    ability(w, self): boolean {
      // Lobbed grenade: slow projectile that explodes on fuse or impact.
      const e = makeEntity('projectile', 'grenade', self.pos.x, self.pos.y, 0.15)
      e.facing = self.facing
      e.vel.x = Math.cos(self.facing) * 7
      e.vel.y = Math.sin(self.facing) * 7
      e.projectile = {
        ownerId: self.id,
        damage: 0,
        ttl: GRENADE_FUSE_TICKS,
        explode: { radius: 1.8, damage: 40 },
      }
      addEntity(w, e)
      return true
    },
  },
}
