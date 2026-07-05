import { makeEntity, type Entity } from './entity'
import { addEntity, type World } from './world'

const PLAYER_SPEED = 4.5
const PLAYER_HP = 100

export const spawnPlayer = (w: World, playerId: number, classId: string, x: number, y: number): Entity => {
  const e = makeEntity('player', 'player', x, y)
  e.speed = PLAYER_SPEED
  e.health = { hp: PLAYER_HP, max: PLAYER_HP, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0 }
  e.playerCtl = {
    playerId,
    classId,
    abilityCooldown: 0,
    inventory: [],
    cash: 0,
    crimeUntilTick: 0,
  }
  return addEntity(w, e)
}
