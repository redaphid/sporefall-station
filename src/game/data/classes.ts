import { makeEntity, type Entity } from '../entity'
import { hasLineOfSight } from '../los'
import { addEntity, doorClosedAt, type World } from '../world'

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
  healMult?: number
  reviveSpeedMult?: number
  /** Locks at or below this level open instantly. */
  autoPickLockLevel?: number
}

const CLOAK_TICKS = 4 * 30
const SLEEP_TICKS = 10 * 30
const SHORTOUT_STUN_TICKS = 2 * 30
const GRENADE_FUSE_TICKS = 24

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
  thief: {
    id: 'thief',
    name: 'Thief',
    hp: 80,
    speed: 5.5,
    startWeapon: 'knife',
    abilityName: 'Cloak',
    abilityCooldownTicks: 12 * 30,
    autoPickLockLevel: 1,
    ability(w, self): boolean {
      self.status!.cloakUntil = w.tick + CLOAK_TICKS
      return true
    },
  },
  doctor: {
    id: 'doctor',
    name: 'Doctor',
    hp: 90,
    speed: 4.5,
    startWeapon: 'fists',
    abilityName: 'Chloroform',
    abilityCooldownTicks: 6 * 30,
    healMult: 2,
    reviveSpeedMult: 2,
    ability(w, self): boolean {
      // Melee-range grab: put the nearest NPC in front of us to sleep.
      let best: Entity | null = null
      let bestDist = Infinity
      for (const e of w.entities) {
        if (!e.ai || e.dead || !e.status) continue
        const dist = Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y)
        if (dist < bestDist && dist <= 1.2 + e.radius) {
          best = e
          bestDist = dist
        }
      }
      if (!best) return false
      best.status!.sleep = SLEEP_TICKS
      best.intent.x = 0
      best.intent.y = 0
      return true
    },
  },
  hacker: {
    id: 'hacker',
    name: 'Hacker',
    hp: 80,
    speed: 4.5,
    startWeapon: 'knife',
    abilityName: 'Short-out',
    abilityCooldownTicks: 10 * 30,
    ability(w, self): boolean {
      const seen = (x: number, y: number): boolean =>
        hasLineOfSight(w.level, self.pos.x, self.pos.y, x, y, (tx, ty) => doorClosedAt(w, tx, ty))
      // Prefer unlocking the nearest locked door; otherwise stun the nearest hostile.
      let door: Entity | null = null
      let doorDist = 6
      let npc: Entity | null = null
      let npcDist = 6
      for (const e of w.entities) {
        if (e.dead) continue
        const dist = Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y)
        if (e.door?.locked && dist < doorDist && seen(e.pos.x, e.pos.y)) {
          door = e
          doorDist = dist
        } else if (e.ai && e.status && e.ai.mode === 'aggro' && dist < npcDist && seen(e.pos.x, e.pos.y)) {
          npc = e
          npcDist = dist
        }
      }
      if (door) {
        door.door!.locked = false
        door.door!.open = true
        w.events.push({ type: 'doorToggle', entityId: door.id, open: true })
        return true
      }
      if (npc) {
        npc.status!.stun = SHORTOUT_STUN_TICKS
        w.events.push({ type: 'hit', x: npc.pos.x, y: npc.pos.y, targetId: npc.id, amount: 0 })
        return true
      }
      return false
    },
  },
}
