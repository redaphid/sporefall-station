/**
 * 8-player performance harness (stress/8-players). Headless, no radio.
 *
 * Measures, on the authoritative host path with a populated floor:
 *   - sim tick cost (ms/tick p50/p99) vs the 30Hz budget (~33.3ms/tick)
 *   - per-tick snapshot BYTES per client (8× per-player data + interest set)
 *   - the resulting bandwidth per client at the 10Hz snapshot rate, and the
 *     aggregate the host radio must push to all clients.
 *
 * Run: pnpm exec tsx scripts/test/stress-8-players.mts
 *
 * This exercises the real NetHostSession sim + snapshot encoder. It does NOT
 * exercise BLE — the radio is the separate, device-tested limiter (see the
 * stress report / GitHub issue for the connection-count ceiling).
 */
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld, tickWorld } from '../../src/game/world'
import type { InputCmd } from '../../src/game/types'
import { emptyInput } from '../../src/game/types'
import { encodeSnapshot, toWireEntity, type WireEntity } from '../../src/net/protocol/messages'

const SIM_HZ = 30
const TICK_BUDGET_MS = 1000 / SIM_HZ // ~33.3ms
const SNAPSHOT_HZ = 10 // SNAPSHOT_INTERVAL_TICKS = 3 → 10Hz at 30Hz sim
const INTEREST_RADIUS = 14
const ENTITY_CAP = 48

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

/** Rebuild the host's per-peer snapshot exactly as NetHostSession.sendSnapshots does. */
const snapshotForAvatar = (world: ReturnType<typeof createWorld>, avatar: { pos: { x: number; y: number } }): Uint8Array => {
  const entities: WireEntity[] = []
  for (const e of world.entities) {
    if (e.dead) continue
    const isPlayer = e.playerCtl !== undefined
    const near =
      Math.abs(e.pos.x - avatar.pos.x) < INTEREST_RADIUS && Math.abs(e.pos.y - avatar.pos.y) < INTEREST_RADIUS
    if (!isPlayer && !near) continue
    entities.push(toWireEntity(e, world.tick))
    if (entities.length >= ENTITY_CAP) break
  }
  return encodeSnapshot({ tick: world.tick, floor: world.floor, alarm: world.alarm, lastInputSeq: 0, entities })
}

const run = (nPlayers: number, ticks: number, combat: boolean): void => {
  const world = createWorld(1234, 1, 'normal')
  populateWorld(world)
  setupFloor(world)

  const avatars = []
  for (let slot = 0; slot < nPlayers; slot++) {
    avatars.push(spawnPlayer(world, slot, world.level.spawn.x + slot * 0.6, world.level.spawn.y))
  }

  const npcCount = world.entities.filter((e) => e.playerCtl === undefined).length

  const tickMs: number[] = []
  const snapBytesPerClient: number[] = [] // per-client snapshot size samples
  const aggBytesPerSnapshotFrame: number[] = [] // sum across all clients per snapshot frame

  for (let t = 0; t < ticks; t++) {
    const inputs = new Map<number, InputCmd>()
    for (let slot = 0; slot < nPlayers; slot++) {
      const cmd = emptyInput()
      // Everyone moves; if combat, everyone also holds attack so weapon/hit systems run.
      cmd.moveX = slot % 2 === 0 ? 1 : -1
      cmd.moveY = slot % 3 === 0 ? 1 : -1
      cmd.attack = combat
      cmd.aimX = 1
      inputs.set(slot, cmd)
    }

    const start = performance.now()
    tickWorld(world, inputs)
    tickMs.push(performance.now() - start)

    // Snapshots fan out at 10Hz (every 3rd tick).
    if (world.tick % 3 === 0) {
      let frameTotal = 0
      for (const a of avatars) {
        if (a.dead) continue
        const bytes = snapshotForAvatar(world, a).length
        snapBytesPerClient.push(bytes)
        frameTotal += bytes
      }
      aggBytesPerSnapshotFrame.push(frameTotal)
    }
  }

  tickMs.sort((a, b) => a - b)
  snapBytesPerClient.sort((a, b) => a - b)
  aggBytesPerSnapshotFrame.sort((a, b) => a - b)

  const p50 = pct(tickMs, 50)
  const p99 = pct(tickMs, 99)
  const snapP50 = pct(snapBytesPerClient, 50)
  const snapP99 = pct(snapBytesPerClient, 99)
  // Per-client downstream bandwidth: p99 snapshot × 10Hz.
  const perClientKbps = (snapP99 * SNAPSHOT_HZ * 8) / 1000
  // Aggregate the host must push to all clients (host also serves itself locally,
  // so clients = nPlayers - 1).
  const aggP99 = pct(aggBytesPerSnapshotFrame, 99)
  const aggKbps = (aggP99 * SNAPSHOT_HZ * 8) / 1000

  console.log(`\n=== ${nPlayers} players | combat=${combat} | ${npcCount} NPCs on floor | ${ticks} ticks ===`)
  console.log(`sim tick ms:      p50=${p50.toFixed(3)}  p99=${p99.toFixed(3)}  (budget ${TICK_BUDGET_MS.toFixed(1)}ms/tick @ ${SIM_HZ}Hz)`)
  console.log(`                  headroom: p99 uses ${((p99 / TICK_BUDGET_MS) * 100).toFixed(1)}% of the 30Hz tick budget`)
  console.log(`snapshot bytes/client: p50=${snapP50}B  p99=${snapP99}B  (cap ${ENTITY_CAP} entities × 10B + header)`)
  console.log(`per-client downstream: ${perClientKbps.toFixed(1)} kbps @ ${SNAPSHOT_HZ}Hz snapshots`)
  console.log(`host aggregate downstream (all ${Math.max(0, nPlayers - 1)} remote clients): ${aggKbps.toFixed(1)} kbps`)
}

console.log('Backseat 8-player performance harness — populated floor, real sim + snapshot encoder')
run(4, 2000, false)
run(8, 2000, false)
run(8, 2000, true)
