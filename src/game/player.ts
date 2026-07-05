import { CLASSES } from './data/classes'
import { makeEntity, type Entity } from './entity'
import { addEntity, type World } from './world'

export const spawnPlayer = (w: World, playerId: number, classId: string, x: number, y: number): Entity => {
  const cls = CLASSES[classId] ?? CLASSES.soldier
  const e = makeEntity('player', 'player', x, y)
  e.speed = cls.speed
  e.health = { hp: cls.hp, max: cls.hp, iframes: 0 }
  e.combat = { weapon: cls.startWeapon, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = {
    playerId,
    classId: cls.id,
    abilityCooldown: 0,
    inventory: [],
    cash: 0,
    crimeUntilTick: 0,
  }
  return addEntity(w, e)
}
