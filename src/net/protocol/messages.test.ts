import { describe, expect, it } from 'vitest'
import { emptyInput } from '../../game/types'
import { SnapFlags } from '../../game/snapshot'
import { frameMessage, StreamReader } from '../framing/chunkedStream'
import {
  applyWireEntity,
  ARCHETYPES,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  toWireEntity,
  type WireEntity,
  type WireSnapshot,
} from './messages'
import { spawnPlayer } from '../../game/player'
import { createWorld } from '../../game/world'

describe('snapshot codec', () => {
  const snap: WireSnapshot = {
    tick: 123456,
    floor: 3,
    alarm: 2,
    lastInputSeq: 4242,
    entities: [
      { id: 7, archetype: 'player', x: 12.34, y: 56.78, facing: 1.5, hpPct: 0.5, flags: 0b10001 },
      { id: 900, archetype: 'thug', x: 0.5, y: 63.5, facing: 4.7, hpPct: 1, flags: 0 },
      { id: 12, archetype: 'pickup.briefcase', x: 33, y: 44, facing: 0, hpPct: 1, flags: 0 },
    ],
  }

  it('round-trips within quantization error', () => {
    const decoded = decodeSnapshot(encodeSnapshot(snap))
    expect(decoded.tick).toBe(snap.tick)
    expect(decoded.floor).toBe(3)
    expect(decoded.alarm).toBe(2)
    expect(decoded.lastInputSeq).toBe(4242)
    expect(decoded.entities).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(decoded.entities[i].id).toBe(snap.entities[i].id)
      expect(decoded.entities[i].archetype).toBe(snap.entities[i].archetype)
      expect(decoded.entities[i].x).toBeCloseTo(snap.entities[i].x, 1)
      expect(decoded.entities[i].y).toBeCloseTo(snap.entities[i].y, 1)
      expect(decoded.entities[i].flags).toBe(snap.entities[i].flags)
    }
    expect(decoded.entities[0].hpPct).toBeCloseTo(0.5, 2)
  })

  it('stays compact: ~10 bytes per entity', () => {
    const bytes = encodeSnapshot(snap)
    expect(bytes.length).toBeLessThanOrEqual(10 + snap.entities.length * 10)
  })

  it('survives BLE-sized fragmentation via the stream reader', () => {
    const bytes = encodeSnapshot(snap)
    const packets = frameMessage(bytes, 20) // brutal 20-byte packets
    expect(packets.length).toBeGreaterThan(1)
    const reader = new StreamReader()
    const out: Uint8Array[] = []
    for (const p of packets) reader.push(p, (m) => out.push(m))
    expect(out).toHaveLength(1)
    expect(decodeSnapshot(out[0]).entities).toHaveLength(3)
  })

  it('reassembles multiple messages interleaved across packet boundaries', () => {
    const a = encodeSnapshot(snap)
    const b = encodeInput({ ...emptyInput(), seq: 9, moveX: 0.5 }, { attack: true, interact: false, special: false })
    const stream = new Uint8Array([...frameMessage(a, 100000)[0], ...frameMessage(b, 100000)[0]])
    const reader = new StreamReader()
    const out: Uint8Array[] = []
    // Feed one byte at a time — the cruelest possible chunking
    for (const byte of stream) reader.push(new Uint8Array([byte]), (m) => out.push(m))
    expect(out).toHaveLength(2)
    expect(decodeSnapshot(out[0]).tick).toBe(123456)
    expect(decodeInput(out[1]).cmd.seq).toBe(9)
  })
})

describe('input codec', () => {
  it('round-trips movement and buttons', () => {
    const cmd = { ...emptyInput(), seq: 500, moveX: -0.7, moveY: 0.3, attack: true, aimX: 0, aimY: 1 }
    const { cmd: decoded, edges } = decodeInput(encodeInput(cmd, { attack: false, interact: true, special: false }))
    expect(decoded.seq).toBe(500)
    expect(decoded.moveX).toBeCloseTo(-0.7, 1)
    expect(decoded.moveY).toBeCloseTo(0.3, 1)
    expect(decoded.attack).toBe(true)
    expect(edges & 2).toBe(2)
    expect(Math.atan2(decoded.aimY, decoded.aimX)).toBeCloseTo(Math.PI / 2, 1)
  })

  it('preserves a centred aim as (0,0) so facing holds instead of snapping right', () => {
    const cmd = { ...emptyInput(), aimX: 0, aimY: 0 }
    const { cmd: decoded } = decodeInput(encodeInput(cmd, { attack: false, interact: false, special: false }))
    expect(decoded.aimX).toBe(0)
    expect(decoded.aimY).toBe(0)
  })
})

// --- Adversarial / boundary coverage ---

const noEdges = { attack: false, interact: false, special: false }

describe('input codec — boundary values', () => {
  it('round-trips full stick deflection at the axis extremes', () => {
    const { cmd } = decodeInput(encodeInput({ ...emptyInput(), moveX: 1, moveY: -1 }, noEdges))
    expect(cmd.moveX).toBeCloseTo(1, 1)
    expect(cmd.moveY).toBeCloseTo(-1, 1)
  })

  it('packs every held-button combination independently', () => {
    for (const [a, i, s] of [
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [true, true, true],
    ] as const) {
      const { cmd } = decodeInput(encodeInput({ ...emptyInput(), attack: a, interact: i, special: s }, noEdges))
      expect([cmd.attack, cmd.interact, cmd.special]).toEqual([a, i, s])
    }
  })

  it('carries edge bits separately from held bits', () => {
    const { edges } = decodeInput(encodeInput(emptyInput(), { attack: true, interact: false, special: true }))
    expect(edges & 1).toBe(1)
    expect(edges & 2).toBe(0)
    expect(edges & 4).toBe(4)
  })

  it('carries the dodge-roll edge on its own bit (bit 8)', () => {
    const rolled = decodeInput(encodeInput(emptyInput(), { attack: false, interact: false, special: false, roll: true }))
    expect(rolled.edges & 8).toBe(8)
    const still = decodeInput(encodeInput(emptyInput(), noEdges))
    expect(still.edges & 8).toBe(0)
  })

  it('masks seq into a u16 so it wraps rather than overflowing', () => {
    expect(decodeInput(encodeInput({ ...emptyInput(), seq: 65535 }, noEdges)).cmd.seq).toBe(65535)
    // 65536 wraps to 0 — this wrap is exactly what host-side seq detection relies on.
    expect(decodeInput(encodeInput({ ...emptyInput(), seq: 65536 }, noEdges)).cmd.seq).toBe(0)
    expect(decodeInput(encodeInput({ ...emptyInput(), seq: 70000 }, noEdges)).cmd.seq).toBe(70000 & 0xffff)
  })
})

const wire = (over: Partial<WireEntity> = {}): WireEntity => ({
  id: 1,
  archetype: 'player',
  x: 10,
  y: 20,
  facing: 0,
  hpPct: 1,
  flags: 0,
  ...over,
})

const oneEntity = (over: Partial<WireEntity>): WireEntity =>
  decodeSnapshot(encodeSnapshot({ tick: 0, floor: 1, alarm: 0, lastInputSeq: 0, entities: [wire(over)] })).entities[0]

describe('snapshot codec — boundary values', () => {
  it('round-trips an empty entity list', () => {
    const out = decodeSnapshot(encodeSnapshot({ tick: 5, floor: 2, alarm: 1, lastInputSeq: 99, entities: [] }))
    expect(out.entities).toHaveLength(0)
    expect(out.lastInputSeq).toBe(99)
  })

  it('normalizes a negative facing into 0..2π', () => {
    expect(oneEntity({ facing: -Math.PI / 2 }).facing).toBeCloseTo((3 * Math.PI) / 2, 1)
  })

  it('clamps hpPct at both extremes', () => {
    expect(oneEntity({ hpPct: 0 }).hpPct).toBe(0)
    expect(oneEntity({ hpPct: 1 }).hpPct).toBeCloseTo(1, 2)
  })

  it('passes combined status flags through untouched', () => {
    const flags = SnapFlags.Downed | SnapFlags.Cloaked | SnapFlags.Stunned
    expect(oneEntity({ flags }).flags).toBe(flags)
  })

  it('ships the Rolling flag host→client so a client renders/agrees on i-frames', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 10, 10)
    p.playerCtl!.roll = { untilTick: w.tick + 12, cooldownUntilTick: w.tick + 40, dirX: 1, dirY: 0 }
    // Host packs the flag while rolling…
    const rollingWire = toWireEntity(p, w.tick)
    expect(rollingWire.flags & SnapFlags.Rolling).toBe(SnapFlags.Rolling)
    // …and the client materializes a live roll marker from it.
    const client = applyWireEntity(undefined, rollingWire, w.tick)
    expect(client.playerCtl!.roll).toBeDefined()
    // Once the roll ends the flag drops and the client clears its marker.
    w.tick = p.playerCtl!.roll.untilTick
    const doneWire = toWireEntity(p, w.tick)
    expect(doneWire.flags & SnapFlags.Rolling).toBe(0)
    expect(applyWireEntity(client, doneWire, w.tick).playerCtl!.roll).toBeUndefined()
  })

  it('round-trips the largest u16 entity id', () => {
    expect(oneEntity({ id: 65535 }).id).toBe(65535)
  })

  it('round-trips every known archetype by index', () => {
    for (const archetype of ARCHETYPES) expect(oneEntity({ archetype }).archetype).toBe(archetype)
  })

  it('maps an unknown archetype to index 0 (player) instead of corrupting the stream', () => {
    expect(oneEntity({ archetype: 'not-a-real-archetype' }).archetype).toBe('player')
  })

  it('round-trips a full 32-bit tick counter past 2^31', () => {
    const big = 4_000_000_000
    expect(decodeSnapshot(encodeSnapshot({ tick: big, floor: 1, alarm: 0, lastInputSeq: 0, entities: [] })).tick).toBe(big)
  })

  it('keeps position within 1/32-tile quantization error', () => {
    const e = oneEntity({ x: 12.531, y: 47.999 })
    expect(Math.abs(e.x - 12.531)).toBeLessThanOrEqual(1 / 32)
    expect(Math.abs(e.y - 47.999)).toBeLessThanOrEqual(1 / 32)
  })
})
