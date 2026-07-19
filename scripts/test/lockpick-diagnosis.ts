// Headless "play it like a player" diagnosis of the locked-door progression
// blocker. For each seed×floor: boot the real world (populate + setupFloor +
// spawnPlayer), teleport next to a locked mission door (players can't路 route
// the whole city here — we're probing the DOOR interaction, not pathfinding),
// press interact ONCE like a player would, and watch what happens for 10s.
// Then: how many presses until the door actually opens? What did each botch do?
// Usage: npx tsx scripts/test/lockpick-diagnosis.ts
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld, tickWorld } from '../../src/game/world'
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { Entity, World } from '../../src/game/world'

const press = (): InputCmd => ({ ...emptyInput(), interact: true })
const idle = (): InputCmd => emptyInput()

const bootWorld = (seed: number, floor: number) => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return { w, p }
}

const missionDoors = (w: World): Entity[] =>
  w.entities.filter((e) => e.door?.locked)

interface DoorResult {
  presses: number
  botches: number
  ticksToOpen: number
  cancelledByShove: number
  damagedDuring: boolean
  opened: boolean
}

/** Player stands at the door and does the naive thing: press Unlock, wait.
 * If nothing happened after the channel window (how would they know?), press again. */
const playDoor = (w: World, p: Entity, door: Entity, maxTicks = 3000): DoorResult => {
  // stand adjacent (outside the door tile, within 1.3 interact range)
  p.pos.x = door.pos.x + 1.0
  p.pos.y = door.pos.y
  p.prevPos.x = p.pos.x
  p.prevPos.y = p.pos.y
  p.health!.iframes = 0
  const res: DoorResult = { presses: 0, botches: 0, ticksToOpen: -1, cancelledByShove: 0, damagedDuring: false, opened: false }
  let sincePress = 999
  const hpBefore = p.health!.hp
  for (let t = 0; t < maxTicks; t++) {
    let cmd = idle()
    const channeling = !!p.playerCtl!.channel
    if (!channeling && !door.door!.open && sincePress > 60) {
      cmd = press()
      res.presses++
      sincePress = 0
    }
    sincePress++
    const hadChannel = !!p.playerCtl!.channel
    tickWorld(w, new Map([[0, cmd]]))
    const hasChannel = !!p.playerCtl!.channel
    if (hadChannel && !hasChannel && !door.door!.open) {
      // channel ended without the door opening: botch (rng) or cancelled (moved/shoved)
      const moved = Math.hypot(p.pos.x - p.prevPos.x, p.pos.y - p.prevPos.y) > 0.02
      if (moved) res.cancelledByShove++
      else res.botches++
    }
    if (p.health!.hp < hpBefore) res.damagedDuring = true
    if (door.door!.open) {
      res.opened = true
      res.ticksToOpen = t
      break
    }
    if (p.dead || p.playerCtl!.downed) break
  }
  return res
}

/** Simulate "the player fought their way to the door": hostiles within radius are gone. */
const secureArea = (w: World, door: Entity, radius = 9): void => {
  for (const e of w.entities) {
    if (!e.ai || e.dead) continue
    if (Math.hypot(e.pos.x - door.pos.x, e.pos.y - door.pos.y) <= radius) {
      e.dead = true
      e.health && (e.health.hp = 0)
    }
  }
}

let totalDoors = 0
let opened = 0
let totalPresses = 0
let totalBotches = 0
let totalShoveCancels = 0
let damaged = 0
let unopened: string[] = []
const lockLevels = new Map<number, number>()
const doorCounts = new Map<number, number>()

const secured = process.argv.includes('--secured')
let totalTicksToOpen = 0
for (let seed = 1; seed <= 50; seed++) {
  for (let floor = 1; floor <= 3; floor++) {
    const { w, p } = bootWorld(seed, floor)
    const doors = missionDoors(w)
    doorCounts.set(doors.length, (doorCounts.get(doors.length) ?? 0) + 1)
    for (const d of doors) lockLevels.set(d.door!.lockLevel, (lockLevels.get(d.door!.lockLevel) ?? 0) + 1)
    // play just the FIRST locked door per world (the entry experience)
    if (doors.length === 0) continue
    const d = doors[0]
    totalDoors++
    if (secured) secureArea(w, d)
    const r = playDoor(w, p, d)
    if (r.opened) {
      opened++
      totalPresses += r.presses
      totalBotches += r.botches
      totalShoveCancels += r.cancelledByShove
      totalTicksToOpen += r.ticksToOpen
      if (r.damagedDuring) damaged++
    } else {
      unopened.push(`seed=${seed} floor=${floor} presses=${r.presses} botches=${r.botches} shoves=${r.cancelledByShove} downed=${!!p.playerCtl!.downed} dead=${p.dead}`)
    }
  }
}

console.log(`--- lockpick diagnosis (50 seeds x floors 1-3, first locked mission door each${secured ? ', area secured first' : ', raw arrival'}) ---`)
console.log(`locked doors played: ${totalDoors}, opened within 100s: ${opened}`)
console.log(`avg presses to open: ${(totalPresses / Math.max(1, opened)).toFixed(2)}, avg seconds to open: ${(totalTicksToOpen / Math.max(1, opened) / 30).toFixed(1)}`)
console.log(`total botches: ${totalBotches}, shove-cancels: ${totalShoveCancels}, runs damaged during pick: ${damaged}`)
console.log(`lock levels seen:`, [...lockLevels.entries()])
console.log(`locked doors per mission world:`, [...doorCounts.entries()].sort((a, b) => a[0] - b[0]))
if (unopened.length) {
  console.log(`FAILED TO OPEN (${unopened.length}):`)
  for (const u of unopened) console.log('  ' + u)
}
