import { WEAPONS } from './data/items'
import { makeEntity, type Entity, type ItemStack } from './entity'
import { addEntity, type World } from './world'

// ---- Player defaults ------------------------------------------------------
// There is no class system: every player IS this. HP/speed/loadout/special are
// plain constants consumed by spawnPlayer and the combat/interaction systems.

export const PLAYER_HP = 120
export const PLAYER_SPEED = 4.5
export const PLAYER_START_WEAPON = 'pistol'
/** Players swing melee weapons harder than NPCs do. */
export const PLAYER_MELEE_MULT = 1.25
/** HUD/touch label for the special (the grenade lob). */
export const SPECIAL_NAME = 'Grenade'
export const SPECIAL_COOLDOWN_TICKS = 8 * 30

const GRENADE_FUSE_TICKS = 24

/** The player's special: a lobbed grenade — slow projectile that explodes on
 * fuse or impact. Host-authoritative; mutates the world and emits events only. */
export const throwGrenade = (w: World, self: Entity): boolean => {
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
}

/** Rounds the starter pistol/gun spawns loaded with — generous so the
 * early game isn't ammo-starved, but FINITE so ammo pickups still matter. */
export const STARTER_AMMO = 200

/** Build the starter weapon as a real slotted ItemStack so it behaves like any
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

export const spawnPlayer = (w: World, playerId: number, x: number, y: number): Entity => {
  const e = makeEntity('player', 'player', x, y)
  e.speed = PLAYER_SPEED
  e.health = { hp: PLAYER_HP, max: PLAYER_HP, iframes: 0 }
  e.combat = { weapon: PLAYER_START_WEAPON, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  const { inventory, activeSlot } = starterLoadout(PLAYER_START_WEAPON)
  e.playerCtl = {
    playerId,
    abilityCooldown: 0,
    inventory,
    activeSlot,
    cash: 0,
    crimeUntilTick: 0,
  }
  return addEntity(w, e)
}
