import { describe, expect, it } from 'vitest'
import { isSolidTile } from '../game/levelgen/level'
import { generateLevel } from '../game/levelgen/generate'
import { emptyInput, type InputCmd } from '../game/types'
import { createWorld, tickWorld } from '../game/world'
import { populateWorld } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { bodyFitsAt, playerSpawnPoint } from '../game/spawnPlacement'
import { nextFloor, setupFloor } from '../game/systems/missions'
import type { InputSource } from '../input/input'
import type { PeerId, Transport, TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * "Someone respawned in a wall." (playtest, 4 players over BLE)
 *
 * `NetHostSession` fans co-op players out from the level's single spawn point by
 * a FIXED offset — `level.spawn.x + slot * 0.6` (netHost.ts:156 for the lobby
 * start, netHost.ts:517 for a late join). Nothing checks that offset against the
 * level. `level.spawn` itself is guaranteed walkable, but the tile 1–4 tiles to
 * its EAST is not: on ~19% of seed/floor/slot combinations it is solid.
 *
 * This is not cosmetic. `moveAndCollide` accepts a step only if the destination
 * circle overlaps no blocked tile (`canStand`, systems/movement.ts) — and a body
 * that STARTS inside a wall fails that test for every direction, including the
 * one that would walk it out. The player is entombed for the rest of the run.
 *
 * The player-visible trigger is a RESPAWN, which is why it read as a death bug:
 * `restart()` ("play again" after a wipe) re-runs `beginGame`, so every client
 * is re-placed on these same unchecked offsets.
 */

class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) =>
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })),
    )
    const transport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) =>
        Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    return {
      session: new NetClientSession(name, input, transport),
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
    }
  }
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Where slot N is ACTUALLY placed. This deliberately calls the production
 * function rather than restating a formula: the bug was that netHost/hostSession
 * each carried their own blind arithmetic, so a test carrying a fourth copy
 * would go green while the shipped code stayed broken. Every host site now
 * funnels through here, and so does this test.
 *
 * Before the fix this was `spawnX + slot * 0.6` and the sweep below read 20.2%.
 */
const slotSpawn = (level: Parameters<typeof playerSpawnPoint>[0], slot: number): { x: number; y: number } =>
  playerSpawnPoint(level, slot)

describe('co-op spawn placement is collision-checked against the level', () => {
  it('a player who rejoins mid-run does not land inside a wall (seed 1, floor 2)', async () => {
    // The reported path: "usually when people die... someone respawned in a
    // wall". A player who dies/drops and comes back takes the LATE-JOIN branch
    // (netHost.ts:506-522), which places them at `level.spawn.x + slot * 0.6`
    // on the floor the party is ALREADY on. Seed 1 / floor 2 puts the spawn at
    // x=62.5 with a wall from x=64, so slots 3+ land inside it.
    const hub = new MockHub()
    const host = new NetHostSession(1, 'Host', stubInput(), hub.hostTransport)
    const early = [1, 2].map((i) => hub.addClient(`P${i + 1}`, stubInput()))
    await host.start()
    for (const c of early) {
      await c.session.start()
      c.connect()
    }
    await flush()
    host.beginGame()
    await flush()

    // The party descends to floor 2, where this seed's spawn corridor is narrow.
    nextFloor(host.world)
    for (let i = 0; i < 5; i++) {
      host.tick()
      await flush()
    }

    // Two more friends walk up and join the run in progress -> slots 3 and 4.
    const late = [3, 4].map((i) => hub.addClient(`P${i + 1}`, stubInput()))
    for (const c of late) {
      await c.session.start()
      c.connect()
    }
    await flush()

    const level = host.world.level
    const inWall = host.world.entities
      .filter((e) => e.playerCtl)
      .map((e) => ({ slot: e.playerCtl!.playerId, x: Number(e.pos.x.toFixed(2)), y: Number(e.pos.y.toFixed(2)) }))
      .filter((p) => isSolidTile(level, Math.floor(p.x), Math.floor(p.y)))

    expect(inWall, `late joiners spawned inside solid tiles: ${JSON.stringify(inWall)}`).toEqual([])
  })

  it('a player placed on the slot offset can still walk (not entombed)', () => {
    // Drives the REAL sim: 8 directions x 40 ticks each. A player inside a wall
    // fails canStand for every step and moves exactly 0.
    const w = createWorld(1, 1, 'normal')
    populateWorld(w)
    setupFloor(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    nextFloor(w) // floor 2 — the measured failure

    const stuck: string[] = []
    for (const slot of [1, 2, 3]) {
      const { x, y } = slotSpawn(w.level, slot)
      const p = spawnPlayer(w, slot, x, y)
      const start = { x: p.pos.x, y: p.pos.y }
      let moved = 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const inputs = new Map([[slot, { ...emptyInput(), moveX: dx, moveY: dy }]])
        for (let t = 0; t < 40; t++) tickWorld(w, inputs)
        moved = Math.max(moved, Math.hypot(p.pos.x - start.x, p.pos.y - start.y))
      }
      if (moved === 0)
        stuck.push(`slot ${slot} at (${x.toFixed(2)},${y.toFixed(2)}) could not move in ANY direction`)
    }
    expect(stuck, stuck.join('; ')).toEqual([])
  })

  it('sweep: the slot offset lands in a wall on <1% of seed/floor/slot combinations', () => {
    let bad = 0
    let wedged = 0
    let total = 0
    const worst: string[] = []
    for (let seed = 1; seed <= 60; seed++) {
      for (let floor = 1; floor <= 5; floor++) {
        const level = generateLevel(seed, floor)
        for (let slot = 1; slot <= 7; slot++) {
          total++
          const { x, y } = slotSpawn(level, slot)
          if (isSolidTile(level, Math.floor(x), Math.floor(y))) {
            bad++
            if (worst.length < 5) worst.push(`seed ${seed} floor ${floor} slot ${slot}`)
          }
          // The STRICTER condition, and the one that actually entombs: the body
          // is a circle, so a centre on an open tile can still be wedged against
          // the wall next door. (Before the fix: 20.2% of slots on the loose test,
          // 24.9% on this one.)
          if (!bodyFitsAt(level, x, y)) wedged++
        }
      }
    }
    expect(
      bad / total,
      `${bad}/${total} co-op spawn slots are inside a wall, e.g. ${worst.join(', ')}`,
    ).toBeLessThan(0.01)
    expect(bad, `${bad}/${total} co-op spawn slots are inside a wall`).toBe(0)
    expect(wedged, `${wedged}/${total} co-op spawn slots cannot fit a player body`).toBe(0)
  })
})
