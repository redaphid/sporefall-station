/**
 * Adversarial / fuzz coverage for the wire PROTOCOL: encode/decode of every
 * message type, hand-crafted hostile buffers, and the guarantee that a peer
 * cannot reach the simulation through them.
 *
 * All randomness comes from the repo's seeded `mulberry32`, never `Math.random()`.
 */
import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../../game/entity'
import { equipSlot } from '../../game/systems/inventory'
import { movementSystem } from '../../game/systems/movement'
import { tryStartRoll } from '../../game/systems/roll'
import { mulberry32 } from '../../game/rng'
import { emptyInput, type InputCmd } from '../../game/types'
import { addEntity, createWorld, type World } from '../../game/world'
import { decodeJson, encodeJson } from '../framing/codec'
import { MsgType } from '../types'
import {
  ARCHETYPES,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  WIRE_MODS,
  type WireEntity,
  type WireSnapshot,
} from './messages'

const randomSnapshot = (seed: number, n: number): WireSnapshot => {
  const rng = mulberry32(seed)
  const entities: WireEntity[] = []
  for (let i = 0; i < n; i++) {
    const archetype = rng.pick(ARCHETYPES)
    const e: WireEntity = {
      id: rng.int(0, 65535),
      archetype,
      x: rng.int(0, 2000) + rng.int(0, 31) / 32,
      y: rng.int(0, 2000) + rng.int(0, 31) / 32,
      facing: rng.next() * Math.PI * 2,
      hpPct: rng.int(0, 255) / 255,
      flags: rng.int(0, 255),
    }
    if (archetype === 'projectile' && rng.chance(0.5)) {
      const count = rng.int(1, 12)
      const mods: { id: string; stacks: number }[] = []
      const used = new Set<string>()
      for (let j = 0; j < count; j++) {
        const id = rng.pick(WIRE_MODS)
        if (used.has(id)) continue
        used.add(id)
        mods.push({ id, stacks: rng.int(1, 8) })
      }
      if (mods.length) e.mods = mods
    }
    entities.push(e)
  }
  return { tick: rng.int(0, 0xffffffff), floor: rng.int(0, 255), alarm: rng.int(0, 255), lastInputSeq: rng.int(0, 65535), entities }
}

describe('snapshot codec — seeded fuzz round-trip', () => {
  it('round-trips 300 seeded snapshots within quantization error', () => {
    for (let s = 0; s < 300; s++) {
      const snap = randomSnapshot(s, mulberry32(s ^ 0xa11ce).int(0, 48))
      const decoded = decodeSnapshot(encodeSnapshot(snap))
      expect(decoded.tick, `seed ${s}`).toBe(snap.tick)
      expect(decoded.floor, `seed ${s}`).toBe(snap.floor)
      expect(decoded.alarm, `seed ${s}`).toBe(snap.alarm)
      expect(decoded.lastInputSeq, `seed ${s}`).toBe(snap.lastInputSeq)
      expect(decoded.entities, `seed ${s}`).toHaveLength(snap.entities.length)
      for (let i = 0; i < snap.entities.length; i++) {
        const a = snap.entities[i]
        const b = decoded.entities[i]
        expect(b.id, `seed ${s} ent ${i}`).toBe(a.id)
        expect(b.archetype, `seed ${s} ent ${i}`).toBe(a.archetype)
        expect(b.flags, `seed ${s} ent ${i}`).toBe(a.flags)
        expect(b.x, `seed ${s} ent ${i}`).toBeCloseTo(a.x, 1)
        expect(b.y, `seed ${s} ent ${i}`).toBeCloseTo(a.y, 1)
        expect(b.hpPct, `seed ${s} ent ${i}`).toBeCloseTo(a.hpPct, 2)
        expect(b.mods?.length ?? 0, `seed ${s} ent ${i}`).toBe(a.mods?.length ?? 0)
        for (const m of a.mods ?? []) {
          expect(b.mods, `seed ${s} ent ${i}`).toContainEqual({ id: m.id, stacks: m.stacks })
        }
      }
    }
  })

  it('a full 48-entity snapshot of MAX-modded projectiles still round-trips', () => {
    // The ByteWriter is preallocated at `16 + n*12`, but a projectile record costs
    // up to 10 + 1 + 12 = 23 bytes, so this case forces the writer to GROW. Pin
    // that the growth path produces a byte-exact message rather than a truncated
    // one — a 48-bullet screen is a normal firefight, not a corner case.
    const mods = WIRE_MODS.slice(0, 12).map((id) => ({ id, stacks: 8 }))
    const entities: WireEntity[] = Array.from({ length: 48 }, (_, i) => ({
      id: i, archetype: 'projectile', x: 10.5, y: 20.25, facing: 1, hpPct: 1, flags: 0, mods: [...mods],
    }))
    const bytes = encodeSnapshot({ tick: 9, floor: 2, alarm: 0, lastInputSeq: 1, entities })
    expect(bytes.length).toBeGreaterThan(16 + 48 * 12) // it really did outgrow the prealloc
    const d = decodeSnapshot(bytes)
    expect(d.entities).toHaveLength(48)
    for (const e of d.entities) expect(e.mods).toHaveLength(12)
  })

  it('collapses a dynamic keycard archetype onto its registered wire index', () => {
    const snap: WireSnapshot = {
      tick: 1, floor: 1, alarm: 0, lastInputSeq: 0,
      entities: [{ id: 1, archetype: 'pickup.keycard.wing3', x: 1, y: 1, facing: 0, hpPct: 1, flags: 0 }],
    }
    // Without normalisation this falls to index 0 and arrives as a second Ranger.
    expect(decodeSnapshot(encodeSnapshot(snap)).entities[0].archetype).toBe('pickup.keycard')
  })
})

describe('snapshot codec — degenerate and out-of-range field values', () => {
  const one = (over: Partial<WireEntity>): WireEntity => ({
    id: 1, archetype: 'player', x: 0, y: 0, facing: 0, hpPct: 1, flags: 0, ...over,
  })
  const rt = (e: WireEntity): WireEntity =>
    decodeSnapshot(encodeSnapshot({ tick: 0, floor: 1, alarm: 0, lastInputSeq: 0, entities: [e] })).entities[0]

  it('never throws on NaN / Infinity coordinates and never emits NaN', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      const d = rt(one({ x: v, y: v, facing: v, hpPct: v }))
      expect(Number.isFinite(d.x)).toBe(true)
      expect(Number.isFinite(d.y)).toBe(true)
      expect(Number.isFinite(d.facing)).toBe(true)
      expect(Number.isFinite(d.hpPct)).toBe(true)
    }
  })

  it('clamps a NEGATIVE position instead of wrapping it to the far side of the map', () => {
    // REGRESSION: positions ride a u16, so x = -0.5 encoded as 65520 and decoded
    // as 2047.5 — an entity nudged out of bounds by knockback teleported to the
    // opposite corner of a ~100-tile map.
    const d = rt(one({ x: -0.5, y: -100 }))
    expect(d.x).toBe(0)
    expect(d.y).toBe(0)
  })

  it('clamps an ABSURDLY LARGE position instead of wrapping it', () => {
    const d = rt(one({ x: 1e9, y: 99999 }))
    expect(d.x).toBeGreaterThan(2000)
    expect(d.x).toBeLessThanOrEqual(0xffff / 32)
    expect(d.y).toBeGreaterThan(2000)
  })

  it('caps the entity list at the u8 count instead of wrapping it', () => {
    // REGRESSION: 300 entities wrote a count byte of 44 (300 & 0xff), so the
    // decoder returned 44 and silently ignored 256 records it never knew existed.
    const entities: WireEntity[] = Array.from({ length: 300 }, (_, i) => ({
      id: i, archetype: 'thug', x: 1, y: 1, facing: 0, hpPct: 1, flags: 0,
    }))
    const d = decodeSnapshot(encodeSnapshot({ tick: 0, floor: 1, alarm: 0, lastInputSeq: 0, entities }))
    expect(d.entities).toHaveLength(255)
    expect(d.entities[254].id).toBe(254)
  })
})

describe('snapshot codec — hostile buffers', () => {
  const hostile = (bytes: number[]): (() => WireSnapshot) => () => decodeSnapshot(new Uint8Array(bytes))

  it('a header-only snapshot with count 0 decodes to an empty entity list', () => {
    expect(hostile([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 0])().entities).toEqual([])
  })

  it('throws (rather than returning garbage) when the entity count runs past the buffer', () => {
    // The session wrappers catch this; what must NEVER happen is a silent decode
    // into fabricated entities.
    expect(hostile([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 255])).toThrow(RangeError)
  })

  it('throws on a truncated entity record', () => {
    expect(hostile([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 0, 3])).toThrow(RangeError)
  })

  it("throws when a projectile's mod count runs past the buffer", () => {
    const projectileIdx = ARCHETYPES.indexOf('projectile')
    expect(hostile([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 0, projectileIdx, 0, 0, 0, 0, 0, 0, 0, 200])).toThrow(RangeError)
  })

  it('throws on an empty or type-byte-only buffer', () => {
    expect(hostile([])).toThrow(RangeError)
    expect(hostile([MsgType.Snapshot])).toThrow(RangeError)
  })

  it('decodes an unknown archetype index to a safe default rather than undefined', () => {
    const d = hostile([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 0, 254, 0, 0, 0, 0, 0, 0, 0])()
    expect(d.entities[0].archetype).toBe('player')
  })

  it('never throws on 2000 seeded-random buffers claiming to be snapshots', () => {
    const rng = mulberry32(0xfa11)
    for (let i = 0; i < 2000; i++) {
      const b = new Uint8Array(rng.int(0, 400))
      for (let j = 0; j < b.length; j++) b[j] = rng.int(0, 255)
      if (b.length > 0) b[0] = MsgType.Snapshot
      // Either it decodes to something finite, or it throws a bounds error. It
      // must never hang, and must never produce NaN coordinates.
      try {
        const d = decodeSnapshot(b)
        for (const e of d.entities) {
          expect(Number.isFinite(e.x), `iter ${i}`).toBe(true)
          expect(Number.isFinite(e.y), `iter ${i}`).toBe(true)
          expect(typeof e.archetype, `iter ${i}`).toBe('string')
        }
      } catch (err) {
        expect(err, `iter ${i}`).toBeInstanceOf(RangeError)
      }
    }
  })
})

describe('input codec — hostile buffers and out-of-contract values', () => {
  it('round-trips 500 seeded input commands', () => {
    const rng = mulberry32(0x1a7)
    for (let i = 0; i < 500; i++) {
      const cmd: InputCmd = {
        ...emptyInput(),
        seq: rng.int(0, 65535),
        moveX: rng.int(-100, 100) / 100,
        moveY: rng.int(-100, 100) / 100,
        attack: rng.chance(0.5),
        interact: rng.chance(0.5),
        special: rng.chance(0.5),
        hotbar: rng.int(-1, 5),
        aimX: rng.int(-100, 100) / 100,
        aimY: rng.int(-100, 100) / 100,
      }
      const edges = { attack: rng.chance(0.5), interact: rng.chance(0.5), special: rng.chance(0.5), roll: rng.chance(0.5), throwItem: rng.chance(0.5) }
      const { cmd: d, edges: e } = decodeInput(encodeInput(cmd, edges))
      expect(d.seq, `iter ${i}`).toBe(cmd.seq)
      expect(d.moveX, `iter ${i}`).toBeCloseTo(cmd.moveX, 1)
      expect(d.moveY, `iter ${i}`).toBeCloseTo(cmd.moveY, 1)
      expect(d.attack, `iter ${i}`).toBe(cmd.attack)
      expect(d.interact, `iter ${i}`).toBe(cmd.interact)
      expect(d.special, `iter ${i}`).toBe(cmd.special)
      expect(d.hotbar, `iter ${i}`).toBe(cmd.hotbar)
      expect(!!(e & 8), `iter ${i}`).toBe(edges.roll)
      expect(!!(e & 16), `iter ${i}`).toBe(edges.throwItem)
    }
  })

  it('throws on a truncated input packet rather than decoding fabricated buttons', () => {
    for (const n of [0, 1, 2, 4, 6]) {
      const b = new Uint8Array(n)
      if (n > 0) b[0] = MsgType.Input
      expect(() => decodeInput(b), `len ${n}`).toThrow(RangeError)
    }
  })

  it('tolerates a legacy 8-byte input packet with no hotbar byte', () => {
    const { cmd } = decodeInput(new Uint8Array([MsgType.Input, 0, 0, 127, 127, 0, 0, 0]))
    expect(cmd.hotbar).toBe(-1)
  })

  it('never throws on 2000 seeded-random input buffers', () => {
    const rng = mulberry32(0x111)
    for (let i = 0; i < 2000; i++) {
      const b = new Uint8Array(rng.int(9, 32))
      for (let j = 0; j < b.length; j++) b[j] = rng.int(0, 255)
      b[0] = MsgType.Input
      const { cmd } = decodeInput(b)
      expect(Number.isFinite(cmd.moveX), `iter ${i}`).toBe(true)
      expect(Number.isFinite(cmd.aimX), `iter ${i}`).toBe(true)
      expect(Number.isFinite(cmd.aimY), `iter ${i}`).toBe(true)
    }
  })
})

describe('a hostile client cannot reach the simulation through the input codec', () => {
  const makePlayer = (w: World): Entity => {
    const e = addEntity(w, makeEntity('player', 'player', 20, 20))
    e.health = { hp: 100, max: 100, iframes: 0 }
    e.speed = 4.5
    e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
    e.loadout = { inventory: [], activeSlot: -1 }
    return e
  }

  /** The worst move vector the wire can carry: byte 255 on both axes. A legitimate
   * encoder tops out at 254 (`round((1+1)*127)`), so 255 only ever comes from a
   * corrupt or malicious peer — and it decodes to 1.0079 per axis, hypot 1.425. */
  const maxMoveCmd = (): InputCmd => decodeInput(new Uint8Array([MsgType.Input, 0, 0, 255, 255, 0, 0, 0, 0])).cmd

  it('an over-range move vector does NOT move a player further than a legal one', () => {
    const hostile = maxMoveCmd()
    expect(Math.hypot(hostile.moveX, hostile.moveY)).toBeGreaterThan(1.4) // the wire really does carry it

    const wa = createWorld(1, 1)
    const a = makePlayer(wa)
    movementSystem(wa, new Map([[0, hostile]]))

    const wb = createWorld(1, 1)
    const b = makePlayer(wb)
    movementSystem(wb, new Map([[0, { ...emptyInput(), moveX: Math.SQRT1_2, moveY: Math.SQRT1_2 }]]))

    // movementSystem normalises anything longer than unit length, so the cheat
    // buys exactly nothing. If that normalisation is ever removed, this goes red.
    expect(Math.hypot(a.intent.x, a.intent.y)).toBeCloseTo(1, 6)
    expect(a.intent.x).toBeCloseTo(b.intent.x, 6)
    expect(a.intent.y).toBeCloseTo(b.intent.y, 6)
  })

  it('an over-range roll vector produces a unit-length roll, not a longer one', () => {
    const w = createWorld(1, 1)
    const e = makePlayer(w)
    const hostile = maxMoveCmd()
    expect(tryStartRoll(w, e, hostile.moveX, hostile.moveY)).toBe(true)
    expect(Math.hypot(e.playerCtl!.roll!.dirX, e.playerCtl!.roll!.dirY)).toBeCloseTo(1, 6)
  })

  it('an out-of-range hotbar slot is refused instead of equipping something absent', () => {
    // The wire carries a +1-biased byte, so 255 decodes to slot 254.
    const { cmd } = decodeInput(new Uint8Array([MsgType.Input, 0, 0, 127, 127, 0, 0, 0, 255]))
    expect(cmd.hotbar).toBe(254)
    const w = createWorld(1, 1)
    const e = makePlayer(w)
    expect(equipSlot(e, cmd.hotbar)).toBe(false)
    expect(e.loadout!.activeSlot).toBe(-1)
  })
})

describe('JSON cold path — hostile payloads', () => {
  it('round-trips every JSON control message', () => {
    const cases: [number, unknown][] = [
      [MsgType.Hello, { v: 3, name: 'Ranger', rejoin: { slot: 2, token: 'abc' } }],
      [MsgType.Welcome, { slot: 1, token: 'tok' }],
      [MsgType.Reject, { reason: 'version mismatch' }],
      [MsgType.LobbyState, { players: [{ slot: 0, name: 'Host' }, { slot: 1, name: 'Bob' }] }],
      [MsgType.GameStart, { seed: 12345, players: [{ slot: 0, name: 'Host' }], mode: 'casual' }],
      [MsgType.Go, { startTick: 90, entityIds: { 0: 1, 1: 2 } }],
      [MsgType.Events, { tick: 7, events: [{ type: 'hit', x: 1, y: 2, targetId: 3, amount: 4 }] }],
      [MsgType.State, { floor: 2, missionText: 'Escape', missionComplete: false, gameOver: false, alarm: 1, huds: {} }],
      [MsgType.Inventory, { slot: 1, inventory: [{ itemId: 'pistol', qty: 6 }], activeSlot: 0, weapon: 'pistol' }],
    ]
    for (const [type, payload] of cases) {
      const bytes = encodeJson(type, payload)
      expect(bytes[0], `type ${type}`).toBe(type)
      expect(decodeJson(bytes), `type ${type}`).toEqual(payload)
    }
  })

  it('throws on malformed JSON rather than returning a half-parsed object', () => {
    expect(() => decodeJson(new Uint8Array([MsgType.State, 0x7b, 0xff, 0xfe]))).toThrow(SyntaxError)
    expect(() => decodeJson(new Uint8Array([MsgType.State]))).toThrow(SyntaxError)
  })

  it('a __proto__ payload does not pollute Object.prototype', () => {
    const body = new TextEncoder().encode('{"__proto__":{"pwned":1},"slot":1}')
    const bytes = new Uint8Array(1 + body.length)
    bytes[0] = MsgType.Welcome
    bytes.set(body, 1)
    const parsed = decodeJson<{ slot: number }>(bytes)
    expect(parsed.slot).toBe(1)
    expect(({} as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('never throws anything but SyntaxError on 1000 seeded-random JSON bodies', () => {
    const rng = mulberry32(0x1509)
    for (let i = 0; i < 1000; i++) {
      const b = new Uint8Array(rng.int(1, 64))
      b[0] = MsgType.State
      for (let j = 1; j < b.length; j++) b[j] = rng.int(0, 255)
      try {
        decodeJson(b)
      } catch (err) {
        expect(err, `iter ${i}`).toBeInstanceOf(SyntaxError)
      }
    }
  })
})
