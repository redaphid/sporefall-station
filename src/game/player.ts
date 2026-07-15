import { CLASSES } from './data/classes'
import { WEAPONS } from './data/items'
import { makeEntity, type Entity, type ItemStack } from './entity'
import { addEntity, type World } from './world'

/** Rounds the class starter pistol/gun spawns loaded with — generous so the
 * early game isn't ammo-starved, but FINITE so ammo pickups still matter. */
export const STARTER_AMMO = 200

/** Build the class starter as a real slotted ItemStack so it behaves like any
 * picked-up weapon: it carries ammo/durability in `qty` and can hold weapon-mods
 * on its `mods` list (the fire site + mod pickups read it via `weaponStack`).
 * A ranged starter loads with STARTER_AMMO rounds, a melee starter with its
 * durability. Innate fists (no magSize/durability) stay UNSLOTTED — bare hands
 * with no mod list, resolving vanilla — so the inventory is empty and
 * activeSlot -1, exactly as before. */
const starterLoadout = (startWeapon: string): { inventory: ItemStack[]; activeSlot: number } => {
  const def = WEAPONS[startWeapon]
  if (def?.kind === 'ranged') return { inventory: [{ itemId: startWeapon, qty: STARTER_AMMO }], activeSlot: 0 }
  if (def?.durability !== undefined) return { inventory: [{ itemId: startWeapon, qty: def.durability }], activeSlot: 0 }
  return { inventory: [], activeSlot: -1 }
}

export const spawnPlayer = (w: World, playerId: number, classId: string, x: number, y: number): Entity => {
  const cls = CLASSES[classId] ?? CLASSES.soldier
  const e = makeEntity('player', 'player', x, y)
  e.speed = cls.speed
  e.health = { hp: cls.hp, max: cls.hp, iframes: 0 }
  e.combat = { weapon: cls.startWeapon, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  const { inventory, activeSlot } = starterLoadout(cls.startWeapon)
  e.playerCtl = {
    playerId,
    classId: cls.id,
    abilityCooldown: 0,
    inventory,
    activeSlot,
    cash: 0,
    crimeUntilTick: 0,
  }
  return addEntity(w, e)
}
