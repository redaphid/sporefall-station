import { makeEntity } from '../entity'
import { generateLevel } from '../levelgen/generate'
import type { Building } from '../levelgen/level'
import { populateWorld, spawnNpc } from '../populate'
import { addEntity, type World } from '../world'

export const setupFloor = (w: World): void => {
  // Mission first — door locking depends on which building it targets.
  generateMission(w)
  spawnDoors(w)
}

/** Door entities on every building door tile. Mission building's exterior doors are locked. */
const spawnDoors = (w: World): void => {
  for (let i = 0; i < w.level.buildings.length; i++) {
    const b = w.level.buildings[i]
    for (const d of b.doors) {
      const e = makeEntity('door', 'door', d.x + 0.5, d.y + 0.5, 0.5)
      const isMissionBuilding = i === w.mission.targetBuilding
      // Locks harden with depth: floor 1-2 pickable by Thief passive, floor 3+ needs a channel
      const lockLevel = isMissionBuilding ? Math.min(2, 1 + Math.floor((w.floor - 1) / 2)) : 0
      e.door = { open: false, locked: isMissionBuilding, lockLevel }
      e.interact = { verb: 'open', range: 1.3 }
      addEntity(w, e)
    }
  }
}

const generateMission = (w: World): void => {
  const rng = w.rng.fork('mission')
  const building = farthestBuilding(w)
  const buildingIdx = building ? w.level.buildings.indexOf(building) : -1

  if (!building) {
    w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Reach the exit' }
    return
  }

  if (rng.chance(0.5)) {
    const spot = roomCenter(building)
    const item = makeEntity('pickup', 'pickup.briefcase', spot.x, spot.y, 0.3)
    item.pickup = { itemId: 'briefcase', qty: 1 }
    addEntity(w, item)
    w.mission = {
      template: 'steal',
      targetEntityId: item.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Steal the briefcase from the ${building.role}`,
    }
  } else {
    const spot = roomCenter(building)
    const boss = spawnNpc(w, 'boss', spot.x, spot.y)
    w.mission = {
      template: 'assassinate',
      targetEntityId: boss.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Take out the boss in the ${building.role}`,
    }
  }
}

const farthestBuilding = (w: World): Building | null => {
  let best: Building | null = null
  let bestDist = -1
  for (const b of w.level.buildings) {
    const cx = b.rect.x + b.rect.w / 2
    const cy = b.rect.y + b.rect.h / 2
    const d = Math.hypot(cx - w.level.spawn.x, cy - w.level.spawn.y)
    if (d > bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}

const roomCenter = (b: Building): { x: number; y: number } => {
  const room = b.rooms.length > 0 ? b.rooms[b.rooms.length - 1] : { x: b.rect.x + 1, y: b.rect.y + 1, w: b.rect.w - 2, h: b.rect.h - 2 }
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 }
}

export const missionSystem = (w: World): void => {
  if (w.gameOver) return

  if (!w.mission.complete) {
    if (w.mission.template === 'steal') {
      const holder = w.entities.find(
        (e) => e.playerCtl && e.playerCtl.inventory.some((s) => s.itemId === 'briefcase'),
      )
      if (holder) completeMission(w)
    } else if (w.mission.template === 'assassinate') {
      const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
      if (!target || target.dead) completeMission(w)
    }
  }

  // Floor transition: any live player standing on the unlocked exit tile
  if (w.mission.exitUnlocked) {
    for (const e of w.entities) {
      if (!e.playerCtl || e.playerCtl.downed || e.dead) continue
      if (Math.floor(e.pos.x) === w.level.exit.x && Math.floor(e.pos.y) === w.level.exit.y) {
        nextFloor(w)
        return
      }
    }
  }

  // Party wipe: every player is downed/dead at once, so no one is left to revive
  // anyone. Ending the run here forced both players to kill and relaunch the app
  // (a page reload drops the BLE link). Instead, pick the whole party back up at
  // the level spawn — away from whatever killed them — so co-op just keeps going.
  const players = w.entities.filter((e) => e.playerCtl)
  if (players.length > 0 && players.every((e) => e.playerCtl!.downed || e.dead)) {
    for (const p of players) {
      p.pos.x = w.level.spawn.x
      p.pos.y = w.level.spawn.y
      p.prevPos.x = p.pos.x
      p.prevPos.y = p.pos.y
      p.vel.x = 0
      p.vel.y = 0
      if (p.health) {
        p.health.hp = Math.max(1, Math.floor(p.health.max / 2))
        p.health.iframes = 90
      }
      if (p.playerCtl) p.playerCtl.downed = undefined
      p.dead = false
    }
    w.events.push({ type: 'partyWipe', floor: w.floor })
  }
}

const completeMission = (w: World): void => {
  w.mission.complete = true
  w.mission.exitUnlocked = true
  w.events.push({ type: 'missionComplete', description: w.mission.description })
}

/** Regenerate the world in place for the next floor, carrying players over. */
export const nextFloor = (w: World): void => {
  const players = w.entities.filter((e) => e.playerCtl)
  w.floor++
  w.level = generateLevel(w.seed, w.floor)
  w.entities = []
  w.byId.clear()
  w.rng = w.baseRng.fork(`sim:${w.floor}`)
  for (const p of players) {
    p.pos.x = w.level.spawn.x
    p.pos.y = w.level.spawn.y
    p.prevPos.x = p.pos.x
    p.prevPos.y = p.pos.y
    p.vel.x = 0
    p.vel.y = 0
    if (p.health) p.health.hp = Math.max(p.health.hp, Math.floor(p.health.max / 2))
    if (p.playerCtl) {
      p.playerCtl.downed = undefined
      p.playerCtl.channel = undefined
      p.playerCtl.crimeUntilTick = 0
      // Key items don't carry across floors
      p.playerCtl.inventory = p.playerCtl.inventory.filter((s) => s.itemId !== 'briefcase')
    }
    p.dead = false
    w.entities.push(p)
    w.byId.set(p.id, p)
  }
  w.alarm = 0
  populateWorld(w)
  setupFloor(w)
  w.events.push({ type: 'floorChange', floor: w.floor })
}
