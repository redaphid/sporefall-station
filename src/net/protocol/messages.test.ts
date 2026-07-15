import { describe, expect, it } from 'vitest'
import { emptyInput } from '../../game/types'
import { frameMessage, StreamReader } from '../framing/chunkedStream'
import { decodeInput, decodeSnapshot, encodeInput, encodeSnapshot, type WireSnapshot } from './messages'

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
