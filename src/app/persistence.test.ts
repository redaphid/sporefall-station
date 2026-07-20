import { describe, expect, it, vi } from 'vitest'
import { HostSession } from './hostSession'
import {
  clearSave,
  createPersister,
  LEGACY_SAVE_KEY,
  makeEnvelope,
  readSave,
  restoreEnvelope,
  SAVE_KEY,
  SAVE_VERSION,
  writeSave,
  type KeyValueStore,
} from './persistence'
import { serializeWorld } from '../game/serialize'
import { runTicks } from '../game/testkit'
import { emptyInput } from '../game/types'
import type { World } from '../game/world'

/** In-memory KeyValueStore so the persistence logic is testable without a DOM. */
const memStore = (): KeyValueStore & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const stubInput = { sample: () => emptyInput() }

/** A real, populated world advanced a few ticks — a representative save subject. */
const liveWorld = (seed = 1, ticks = 5): World => {
  const s = new HostSession(seed, stubInput)
  for (let i = 0; i < ticks; i++) s.tick()
  return s.world
}

const oneInput = new Map([[0, {}]])

describe('persistence — save/restore round-trip', () => {
  it('a saved world restores byte-identical (whole world, incl. RNG position)', () => {
    const store = memStore()
    const w = liveWorld(1, 8)
    const snapshot = serializeWorld(w)
    writeSave(store, w, 12345)
    const restored = readSave(store)
    expect(restored).not.toBeNull()
    expect(serializeWorld(restored!)).toEqual(snapshot)
  })

  it('the restored world CONTINUES bit-exact — N ticks match the original', () => {
    const store = memStore()
    const w = liveWorld(3, 6) // state S, not advanced past this point
    writeSave(store, w, 0)
    const restored = readSave(store)!
    // Run identical inputs on both from the same snapshot; RNG stream position
    // must survive the round-trip or these diverge.
    runTicks(w, oneInput, 40)
    runTicks(restored, oneInput, 40)
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('the envelope carries the version + a savedAt stamp; world is a WorldJson', () => {
    const env = makeEnvelope(liveWorld(2, 2), 999)
    expect(env.v).toBe(SAVE_VERSION)
    expect(env.savedAt).toBe(999)
    expect(env.world.seed).toBe(2)
  })
})

describe('persistence — validation & invalidation (never throw on a bad save)', () => {
  it('missing save → null', () => {
    expect(readSave(memStore())).toBeNull()
  })

  it('garbage JSON → null AND the corrupt slot is discarded', () => {
    const store = memStore()
    store.setItem(SAVE_KEY, '{not valid json…')
    expect(readSave(store)).toBeNull()
    expect(store.map.has(SAVE_KEY)).toBe(false) // dropped so it can't wedge every boot
  })

  it('version mismatch → null and discarded', () => {
    const store = memStore()
    const env = makeEnvelope(liveWorld(), 0)
    store.setItem(SAVE_KEY, JSON.stringify({ ...env, v: SAVE_VERSION + 1 }))
    expect(readSave(store)).toBeNull()
    expect(store.map.has(SAVE_KEY)).toBe(false)
  })

  it('a structurally-broken snapshot (checksum drift) → null, no throw', () => {
    const store = memStore()
    const env = makeEnvelope(liveWorld(), 0)
    // Corrupt the level checksum → deserializeWorld throws → restore falls back.
    env.world.levelChecksum = env.world.levelChecksum ^ 0xdeadbeef
    store.setItem(SAVE_KEY, JSON.stringify(env))
    expect(() => readSave(store)).not.toThrow()
    expect(readSave(store)).toBeNull()
  })

  it('restoreEnvelope rejects non-objects and missing world', () => {
    expect(restoreEnvelope(null)).toBeNull()
    expect(restoreEnvelope('nope')).toBeNull()
    expect(restoreEnvelope(42)).toBeNull()
    expect(restoreEnvelope({ v: SAVE_VERSION })).toBeNull() // no `world`
    expect(restoreEnvelope({ v: SAVE_VERSION, world: null })).toBeNull()
  })

  it('a wrong-version envelope is discarded even if `world` is a valid snapshot', () => {
    const good = makeEnvelope(liveWorld(), 0)
    expect(restoreEnvelope({ v: 999, world: good.world })).toBeNull()
  })
})

describe('persistence — resilience to a hostile store', () => {
  it('writeSave swallows a throwing setItem (quota / private mode)', () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded')
      },
      removeItem: () => {},
    }
    expect(() => writeSave(store, liveWorld(), 0)).not.toThrow()
  })

  it('readSave swallows a throwing getItem → null', () => {
    const store: KeyValueStore = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(readSave(store)).toBeNull()
  })

  it('clearSave swallows a throwing removeItem', () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('boom')
      },
    }
    expect(() => clearSave(store)).not.toThrow()
  })
})

describe('persistence — throttled persister', () => {
  it('saves on cadence, NOT every tick', () => {
    const store = memStore()
    const set = vi.spyOn(store, 'setItem')
    const persister = createPersister(store, { intervalTicks: 45, now: () => 0 })
    const w = liveWorld(1, 0)
    // Drive 90 sim ticks, calling maybeSave once per tick as the frame loop does.
    for (let i = 0; i < 90; i++) {
      runTicks(w, oneInput, 1)
      persister.maybeSave(w)
    }
    // First eligible call saves (tick 1), then once per 45 advanced ticks — far
    // fewer than the 90 maybeSave calls.
    expect(set.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(set.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('a paused/idle world (no tick advance) does not re-save', () => {
    const store = memStore()
    const set = vi.spyOn(store, 'setItem')
    const persister = createPersister(store, { intervalTicks: 10, now: () => 0 })
    const w = liveWorld(1, 20)
    persister.maybeSave(w) // first save at the current tick
    const after = set.mock.calls.length
    for (let i = 0; i < 50; i++) persister.maybeSave(w) // world never advances
    expect(set.mock.calls.length).toBe(after) // no further writes
  })

  it('flush forces a write only when the world advanced since the last save', () => {
    const store = memStore()
    const set = vi.spyOn(store, 'setItem')
    const persister = createPersister(store, { intervalTicks: 1000, now: () => 0 })
    const w = liveWorld(1, 3)
    persister.flush(w)
    expect(set).toHaveBeenCalledTimes(1)
    persister.flush(w) // no advance → no duplicate write
    expect(set).toHaveBeenCalledTimes(1)
    runTicks(w, oneInput, 1)
    persister.flush(w) // advanced → writes again
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('a persister write is restorable (integration: persister → readSave)', () => {
    const store = memStore()
    const persister = createPersister(store, { intervalTicks: 1, now: () => 0 })
    const w = liveWorld(7, 4)
    persister.maybeSave(w)
    const restored = readSave(store)!
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('clear() removes the save and resets the throttle', () => {
    const store = memStore()
    const persister = createPersister(store, { intervalTicks: 45, now: () => 0 })
    const w = liveWorld(1, 50)
    persister.maybeSave(w)
    expect(store.map.has(SAVE_KEY)).toBe(true)
    persister.clear()
    expect(store.map.has(SAVE_KEY)).toBe(false)
    // Throttle reset → the very next maybeSave writes again immediately.
    const set = vi.spyOn(store, 'setItem')
    persister.maybeSave(w)
    expect(set).toHaveBeenCalledTimes(1)
  })
})

describe('persistence — rebrand save migration (sor.savegame → sporefall.savegame)', () => {
  it('adopts a pre-rebrand run: legacy key present, new absent → restored under the new key', () => {
    const store = memStore()
    const w = liveWorld(7, 9) // a real in-progress run at "floor N"
    const snapshot = serializeWorld(w)
    // Simulate a save written by the pre-rename build.
    store.map.set(LEGACY_SAVE_KEY, JSON.stringify(makeEnvelope(w, 999)))

    const restored = readSave(store)
    expect(restored).not.toBeNull()
    expect(serializeWorld(restored!)).toEqual(snapshot) // the run survives the rename
    // Migrated exactly once: value now lives under the new key, legacy reclaimed.
    expect(store.map.has(SAVE_KEY)).toBe(true)
    expect(store.map.has(LEGACY_SAVE_KEY)).toBe(false)
  })

  it('prefers the new key: a current sporefall.savegame wins, legacy is ignored', () => {
    const store = memStore()
    const current = liveWorld(2, 4)
    writeSave(store, current, 0) // new-key save from the renamed build
    store.map.set(LEGACY_SAVE_KEY, '{"totally":"stale garbage"}') // stale legacy blob

    const restored = readSave(store)
    expect(restored).not.toBeNull()
    expect(serializeWorld(restored!)).toEqual(serializeWorld(current))
    expect(store.map.get(LEGACY_SAVE_KEY)).toBe('{"totally":"stale garbage"}') // untouched
  })

  it('both keys absent → a fresh run (null), nothing created', () => {
    const store = memStore()
    expect(readSave(store)).toBeNull()
    expect(store.map.size).toBe(0)
  })
})
