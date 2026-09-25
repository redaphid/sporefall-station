import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { runTicks } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import {
  captureState,
  firstDifference,
  isStateLinkPayload,
  newStateId,
  STATE_ID_LENGTH,
  STATE_ID_RE,
  StateRing,
  verifyStateLink,
  type StateLinkPayload,
} from './stateLink'
import { worldDigest } from './worldDigest'

/** A mid-run world whose sim RNG has genuinely advanced past its seed — the only
 * kind of world that can expose an RNG-cursor bug. */
const buildMidRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  return runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 50)
}

const DRIVE: Map<number, InputCmd> = new Map([[0, { ...emptyInput(), moveX: 1, attack: true }]])

/** Tick a world n times with the same command every tick. */
const drive = (w: World, n: number): World => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map(DRIVE))
  return w
}

describe('captureState / restore', () => {
  it('restores a captured world and then CONTINUES identically for 300 ticks', () => {
    const original = buildMidRun(0xdecaf)
    const payload = captureState(original, { note: 'round-trip' })

    // Through a real JSON string, the way it travels to Cloudflare and back.
    const restored = deserializeWorld(JSON.parse(JSON.stringify(payload.world)) as WorldJson)

    // Identical at rest...
    expect(worldDigest(restored)).toBe(worldDigest(original))

    // ...and identical after both run forward. This is the assertion that
    // matters: a snapshot that loads and THEN diverges is the failure mode.
    drive(original, 300)
    drive(restored, 300)
    expect(worldDigest(restored)).toBe(worldDigest(original))
    expect(original.tick).toBe(350)
  })

  it('carries the run difficulty and the revive economy (sim inputs, not cosmetics)', () => {
    const w = buildMidRun(11)
    w.mode = 'casual'
    w.revivesLeft = 0
    const restored = deserializeWorld(serializeWorld(w))
    expect(restored.mode).toBe('casual')
    expect(restored.revivesLeft).toBe(0)
    expect(worldDigest(restored)).toBe(worldDigest(w))
  })

  it('omits difficulty/revives at their defaults so older snapshots stay byte-for-byte', () => {
    const j = serializeWorld(buildMidRun(12))
    expect(j).not.toHaveProperty('mode')
    expect(j).not.toHaveProperty('revivesLeft')
  })
})

// ---- negative controls: a green that has never been watched go red is not
// evidence. Each of these breaks ONE thing and demands the check notice.
describe('the divergence check can actually fail', () => {
  it('goes RED when the RNG cursor is dropped (the classic lying-snapshot bug)', () => {
    const original = buildMidRun(0xbeef)
    const good = serializeWorld(original)

    // Sabotage exactly one field: the sim stream position. The world still looks
    // perfectly right — same entities, same positions, same hp, same level.
    const sabotaged = deserializeWorld({ ...good, rng: good.rng + 1 })
    expect(sabotaged.entities.length).toBe(original.entities.length)

    // ...and it diverges the moment both run forward. Without this the tool
    // would hand a friend a world that looks identical and behaves differently.
    drive(original, 300)
    drive(sabotaged, 300)
    expect(worldDigest(sabotaged)).not.toBe(worldDigest(original))
  })

  it('goes RED when the revive economy is dropped from the payload', () => {
    const original = buildMidRun(0xfeed)
    original.revivesLeft = 0
    const withoutRevives = { ...serializeWorld(original) }
    delete withoutRevives.revivesLeft // exactly what the pre-fix schema did
    const restored = deserializeWorld(withoutRevives)
    expect(restored.revivesLeft).toBe(2) // silently handed the party its comebacks back
    expect(worldDigest(restored)).not.toBe(worldDigest(original))
  })

  it('shows WHY the old comparison was blind: it compares through the schema', () => {
    // Two genuinely different worlds — one party has burned both comebacks.
    const a = buildMidRun(0xc0ffee)
    const b = buildMidRun(0xc0ffee)
    b.revivesLeft = 0

    // The live-world digest sees the difference.
    expect(worldDigest(a)).not.toBe(worldDigest(b))

    // But strip the field from both snapshots — precisely what the schema did
    // before this branch — and comparing THROUGH the snapshot calls them equal.
    const throughSchema = (w: World): Partial<WorldJson> => {
      const j = { ...serializeWorld(w) }
      delete j.revivesLeft
      return j
    }
    expect(throughSchema(a)).toEqual(throughSchema(b))
  })
})

describe('StateRing (the moments before the bug)', () => {
  it('replays its rewind forward onto the captured world, byte-for-byte', () => {
    const w = buildMidRun(7)
    const ring = new StateRing(w, 30)
    for (let i = 0; i < 95; i++) {
      tickWorld(w, new Map(DRIVE))
      ring.observe(w, DRIVE)
    }

    const payload = captureState(w, { note: 'rewind' }, ring.rewind())
    const check = verifyStateLink(payload)
    expect(check.ok).toBe(true)
    // Double-buffered, so there is always at least one full window of lead-in.
    expect(check.rewindTicks).toBeGreaterThanOrEqual(30)
    expect(payload.rewind!.world.tick).toBeLessThan(payload.world.tick)
  })

  it('always carries a full window of lead-in, even right after a rotation', () => {
    const w = buildMidRun(8)
    const ring = new StateRing(w, 30)
    for (let i = 0; i < 60; i++) {
      // 60 = exactly two windows: the naive single-checkpoint ring would have
      // just rotated and be holding ZERO ticks of history at this instant.
      tickWorld(w, new Map(DRIVE))
      ring.observe(w, DRIVE)
    }
    expect(ring.rewind().frames.length).toBeGreaterThanOrEqual(30)
    expect(verifyStateLink(captureState(w, {}, ring.rewind())).ok).toBe(true)
  })

  it('verifyStateLink goes RED when the rewind inputs do not lead to the capture', () => {
    const w = buildMidRun(9)
    const ring = new StateRing(w, 20)
    for (let i = 0; i < 50; i++) {
      tickWorld(w, new Map(DRIVE))
      ring.observe(w, DRIVE)
    }
    const payload = captureState(w, {}, ring.rewind())
    // Drop a single tick of input from the middle of the run-up.
    payload.rewind!.frames.splice(5, 1)
    const check = verifyStateLink(payload)
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/did not reproduce/)
  })
})

describe('divergence reporting (turning "it does not work" into a fixable bug)', () => {
  /** A capture with a real run-up recorded behind it. */
  const captureWithRewind = (seed: number, window = 30, ticks = 70): StateLinkPayload => {
    const w = buildMidRun(seed)
    const ring = new StateRing(w, window)
    for (let i = 0; i < ticks; i++) {
      tickWorld(w, new Map(DRIVE))
      ring.observe(w, DRIVE)
    }
    return captureState(w, { note: 'diverge' }, ring.rewind())
  }

  it('names the TICK the replay first drifted, via the per-tick signatures', () => {
    const payload = captureWithRewind(0xa11ce)
    // Sabotage the RNG cursor of the world the replay STARTS from. Every
    // subsequent AI/loot roll comes off the wrong stream — precisely the bug
    // that makes a naive snapshot look right and behave wrong.
    payload.rewind!.world.rng += 1

    const check = verifyStateLink(payload)
    expect(check.ok).toBe(false)
    // The very first replayed tick already draws from the wrong stream.
    expect(check.divergedAtTick).toBe(payload.rewind!.frames[0]!.tick)
    expect(check.reason).toMatch(/from tick \d+/)
  })

  it('names the FIELD that differs, not just "they differ"', () => {
    const payload = captureWithRewind(0xb0b)
    // Corrupt the captured end state instead, so the replay is fine and the
    // final compare is what fails — on a specific, nameable field.
    const hp = (payload.world.entities[1] as { health?: { hp: number } }).health
    expect(hp).toBeDefined()
    hp!.hp -= 7

    const check = verifyStateLink(payload)
    expect(check.ok).toBe(false)
    expect(check.difference?.path).toBe('entities[1].health.hp')
    expect(check.reason).toMatch(/entities\[1\]\.health\.hp/)
  })

  it('a healthy capture reports ok with no divergence at all', () => {
    const check = verifyStateLink(captureWithRewind(0xc0de))
    expect(check.ok).toBe(true)
    expect(check.divergedAtTick).toBeUndefined()
    expect(check.difference).toBeUndefined()
    expect(check.rewindTicks).toBeGreaterThanOrEqual(30)
  })

  it('records a per-tick signature for every frame', () => {
    const payload = captureWithRewind(0xd06)
    expect(payload.rewind!.frames.every((f) => Array.isArray(f.sig) && f.sig.length === 2)).toBe(true)
  })
})

describe('firstDifference', () => {
  it('finds the first differing path depth-first', () => {
    expect(firstDifference({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })?.path).toBe('b.c')
    expect(firstDifference([1, 2, 3], [1, 9, 3])?.path).toBe('[1]')
    expect(firstDifference({ a: [{ x: 1 }] }, { a: [{ x: 2 }] })?.path).toBe('a[0].x')
  })

  it('reports a length change rather than walking off the end', () => {
    const d = firstDifference({ a: [1, 2] }, { a: [1] })
    expect(d?.path).toBe('a.length')
    expect(d?.expected).toBe('2')
    expect(d?.actual).toBe('1')
  })

  it('treats absent and undefined as equal (a JSON round-trip artefact, not a bug)', () => {
    expect(firstDifference({ a: 1, path: undefined }, { a: 1 })).toBeNull()
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull()
  })

  it('does NOT treat null as undefined — null is a real value that survives JSON', () => {
    expect(firstDifference({ a: null }, { a: undefined })?.path).toBe('a')
  })
})

describe('state ids', () => {
  it('is 16 chars of unambiguous base32', () => {
    const id = newStateId(new Uint8Array(Array.from({ length: 16 }, (_, i) => i * 7)))
    expect(id).toHaveLength(STATE_ID_LENGTH)
    expect(id).toMatch(STATE_ID_RE)
    expect(id).not.toMatch(/[ilou]/) // survives being read aloud / retyped
  })

  it('maps distinct byte streams to distinct ids', () => {
    const a = newStateId(new Uint8Array(16).fill(0))
    const b = newStateId(new Uint8Array(16).fill(1))
    expect(a).not.toBe(b)
    expect(STATE_ID_RE.test(a) && STATE_ID_RE.test(b)).toBe(true)
  })

  it('refuses to build an id from too little entropy', () => {
    expect(() => newStateId(new Uint8Array(4))).toThrow(/random bytes/)
  })
})

describe('payload guard', () => {
  it('accepts a real payload and rejects junk', () => {
    const p = captureState(buildMidRun(3), { note: 'x' })
    expect(isStateLinkPayload(JSON.parse(JSON.stringify(p)))).toBe(true)
    expect(isStateLinkPayload(null)).toBe(false)
    expect(isStateLinkPayload({ v: 99, world: {} })).toBe(false)
    expect(isStateLinkPayload({ v: 1 })).toBe(false)
  })

  it('meta never reaches the sim', () => {
    const w = buildMidRun(4)
    const withMeta = captureState(w, { note: 'a bug', build: '248', capturedAt: 1 })
    const withoutMeta = captureState(w, {})
    expect(withMeta.world).toEqual(withoutMeta.world)
  })
})

describe('payload size (the number that decides whether this is shareable)', () => {
  it('reports the real byte cost of a mid-run capture', () => {
    const w = createWorld(0xdecaf, 1)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    drive(w, 200)
    const ring = new StateRing(w, 180)
    for (let i = 0; i < 200; i++) {
      tickWorld(w, new Map(DRIVE))
      ring.observe(w, DRIVE)
    }
    const bare = JSON.stringify(captureState(w, { note: 'size' })).length
    const withRewind = JSON.stringify(captureState(w, { note: 'size' }, ring.rewind())).length
    // Not a golden number — a ceiling. KV's value limit is 25 MiB; if a capture
    // ever approached even 1 MiB something has gone structurally wrong.
    expect(bare).toBeLessThan(1_000_000)
    expect(withRewind).toBeGreaterThan(bare)
    console.log(`capture: bare=${(bare / 1024).toFixed(1)} KiB  with-rewind=${(withRewind / 1024).toFixed(1)} KiB`)
  })
})

/** Guards the shape the Worker stores, so a schema drift is caught here. */
const _typecheck: StateLinkPayload = captureState(createWorld(1, 1), {})
void _typecheck
