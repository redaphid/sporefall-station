import { describe, expect, it } from 'vitest'
import type { KeyValueStore } from './persistence'
import {
  REJOIN_KEY,
  REJOIN_TTL_MS,
  REJOIN_VERSION,
  clearRejoin,
  readRejoin,
  writeRejoin,
  type RejoinRecord,
} from './rejoinStore'

/** An in-memory `KeyValueStore`, plus hooks to make it misbehave like a real one. */
const memStore = (
  seed: Record<string, string> = {},
): KeyValueStore & { map: Map<string, string>; failGet?: boolean; failSet?: boolean } => {
  const map = new Map(Object.entries(seed))
  const store = {
    map,
    getItem(key: string): string | null {
      if (store.failGet) throw new Error('SecurityError: storage is not available')
      return map.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      if (store.failSet) throw new Error('QuotaExceededError')
      map.set(key, value)
    },
    removeItem(key: string): void {
      map.delete(key)
    },
  } as KeyValueStore & { map: Map<string, string>; failGet?: boolean; failSet?: boolean }
  return store
}

const record = (over: Partial<RejoinRecord> = {}): RejoinRecord => ({
  v: REJOIN_VERSION,
  runId: 'run-abc',
  slot: 3,
  token: 'tok123456',
  savedAt: 1_000_000,
  ...over,
})

describe('rejoinStore — round trip', () => {
  it('writes a record and reads back exactly what went in', () => {
    const store = memStore()
    const rec = record()
    writeRejoin(store, rec)
    expect(readRejoin(store, rec.savedAt)).toEqual(rec)
  })

  it('uses the sporefall.* key convention, like every other persisted slot', () => {
    const store = memStore()
    writeRejoin(store, record())
    expect(store.map.has(REJOIN_KEY)).toBe(true)
    expect(REJOIN_KEY.startsWith('sporefall.')).toBe(true)
  })

  it('returns null when nothing was ever written', () => {
    expect(readRejoin(memStore(), 0)).toBeNull()
  })

  it('overwrites the single slot rather than accumulating records', () => {
    const store = memStore()
    writeRejoin(store, record({ slot: 2, token: 'first00000' }))
    writeRejoin(store, record({ slot: 5, token: 'second0000' }))
    expect(store.map.size).toBe(1)
    expect(readRejoin(store, 1_000_000)?.slot).toBe(5)
  })

  it('clears the slot', () => {
    const store = memStore()
    writeRejoin(store, record())
    clearRejoin(store)
    expect(readRejoin(store, 1_000_000)).toBeNull()
  })
})

describe('rejoinStore — expiry', () => {
  it('serves a record inside the TTL', () => {
    const store = memStore()
    writeRejoin(store, record({ savedAt: 1_000 }))
    expect(readRejoin(store, 1_000 + REJOIN_TTL_MS - 1)).not.toBeNull()
  })

  it('refuses a record older than the TTL', () => {
    const store = memStore()
    writeRejoin(store, record({ savedAt: 1_000 }))
    expect(readRejoin(store, 1_000 + REJOIN_TTL_MS + 1)).toBeNull()
  })

  it('drops the expired record instead of re-parsing it on every boot', () => {
    const store = memStore()
    writeRejoin(store, record({ savedAt: 1_000 }))
    readRejoin(store, 1_000 + REJOIN_TTL_MS + 1)
    expect(store.map.has(REJOIN_KEY)).toBe(false)
  })

  it('tolerates a clock that jumped BACKWARDS rather than discarding a live seat', () => {
    // Android wall-clock can step back (NTP sync, timezone/DST churn). A negative
    // age is skew, not staleness — the host is the authority on whether the ghost
    // is still there, so do not throw a good token away over it.
    const store = memStore()
    writeRejoin(store, record({ savedAt: 5_000_000 }))
    expect(readRejoin(store, 1_000)).not.toBeNull()
  })

  it('the TTL comfortably outlives the host 90s rejoin grace', () => {
    // Anything shorter would expire a token the host would still have honoured.
    expect(REJOIN_TTL_MS).toBeGreaterThan(90_000)
  })
})

describe('rejoinStore — corrupt, truncated and hostile blobs', () => {
  const bad: [string, string][] = [
    ['garbage', 'not json at all'],
    ['truncated json', '{"v":1,"runId":"run-abc","slot":3,"tok'],
    ['a bare array', '[1,2,3]'],
    ['null', 'null'],
    ['a naked string', '"hello"'],
    ['an empty object', '{}'],
    ['wrong version', JSON.stringify({ ...record(), v: 99 })],
    ['missing token', JSON.stringify({ v: REJOIN_VERSION, runId: 'r', slot: 3, savedAt: 1 })],
    ['token of the wrong type', JSON.stringify({ ...record(), token: 12345 })],
    ['empty token', JSON.stringify({ ...record(), token: '' })],
    ['absurdly long token', JSON.stringify({ ...record(), token: 'x'.repeat(5000) })],
    ['missing runId', JSON.stringify({ v: REJOIN_VERSION, slot: 3, token: 'tok', savedAt: 1 })],
    ['empty runId', JSON.stringify({ ...record(), runId: '' })],
    ['slot of the wrong type', JSON.stringify({ ...record(), slot: '3' })],
    ['fractional slot', JSON.stringify({ ...record(), slot: 3.5 })],
    ['negative slot', JSON.stringify({ ...record(), slot: -1 })],
    // Slot 0 is the HOST's own seat and is never issued to a client; a record
    // claiming it is corrupt (or forged) and must never reach the wire.
    ['the host seat', JSON.stringify({ ...record(), slot: 0 })],
    ['NaN savedAt', JSON.stringify({ ...record(), savedAt: null })],
  ]

  for (const [label, raw] of bad) {
    it(`refuses ${label}`, () => {
      const store = memStore({ [REJOIN_KEY]: raw })
      expect(readRejoin(store, 1_000_000)).toBeNull()
    })

    it(`drops ${label} from storage so it cannot wedge every later boot`, () => {
      const store = memStore({ [REJOIN_KEY]: raw })
      readRejoin(store, 1_000_000)
      expect(store.map.has(REJOIN_KEY)).toBe(false)
    })
  }
})

describe('rejoinStore — storage that is unavailable or throwing', () => {
  it('reads null instead of throwing when getItem throws (private mode / locked webview)', () => {
    const store = memStore()
    store.failGet = true
    expect(() => readRejoin(store, 0)).not.toThrow()
    expect(readRejoin(store, 0)).toBeNull()
  })

  it('swallows a quota failure on write', () => {
    const store = memStore()
    store.failSet = true
    expect(() => writeRejoin(store, record())).not.toThrow()
  })

  it('swallows a failure on clear', () => {
    const store = memStore()
    store.removeItem = () => {
      throw new Error('nope')
    }
    expect(() => clearRejoin(store)).not.toThrow()
  })
})
