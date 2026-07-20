// Adversarial coverage for the rebrand localStorage key migration. The player
// mid-run when Backseat→Sporefall Station lands must NOT lose their save/settings
// to the key rename — so this exercises the exact copy-once semantics and every
// degenerate store behaviour (already-migrated, both-present, empty value,
// throwing store).

import { describe, expect, it } from 'vitest'
import { migrateLegacyKey, type LocalStorageLike } from './storageMigration'

const memStore = (init: Record<string, string> = {}): LocalStorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>(Object.entries(init))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const NEW = 'sporefall.k'
const OLD = 'sor.k'

describe('migrateLegacyKey', () => {
  it('new absent + legacy present → copies value to new and drops the legacy key', () => {
    const s = memStore({ [OLD]: 'run-state' })
    migrateLegacyKey(s, NEW, OLD)
    expect(s.getItem(NEW)).toBe('run-state')
    expect(s.getItem(OLD)).toBeNull() // legacy slot reclaimed
  })

  it('new present → legacy is IGNORED (never overwrites the current value)', () => {
    const s = memStore({ [NEW]: 'current', [OLD]: 'stale' })
    migrateLegacyKey(s, NEW, OLD)
    expect(s.getItem(NEW)).toBe('current')
    expect(s.getItem(OLD)).toBe('stale') // left untouched — no destructive cleanup
  })

  it('both absent → no-op, nothing created', () => {
    const s = memStore()
    migrateLegacyKey(s, NEW, OLD)
    expect(s.getItem(NEW)).toBeNull()
    expect(s.getItem(OLD)).toBeNull()
    expect(s.map.size).toBe(0)
  })

  it('runs exactly once — a second call after migration is a clean no-op', () => {
    const s = memStore({ [OLD]: 'v' })
    migrateLegacyKey(s, NEW, OLD)
    s.setItem(NEW, 'changed-since') // simulate later writes under the new key
    migrateLegacyKey(s, NEW, OLD) // legacy already gone, new present
    expect(s.getItem(NEW)).toBe('changed-since')
    expect(s.getItem(OLD)).toBeNull()
  })

  it('migrates an empty-string legacy value (a stored "" is a value, not absence)', () => {
    const s = memStore({ [OLD]: '' })
    migrateLegacyKey(s, NEW, OLD)
    expect(s.getItem(NEW)).toBe('')
    expect(s.getItem(OLD)).toBeNull()
  })

  it('never throws when setItem fails (quota/private mode) and leaves legacy intact', () => {
    const s: LocalStorageLike = {
      getItem: (k) => (k === OLD ? 'precious' : null),
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('should not be reached after a failed set')
      },
    }
    expect(() => migrateLegacyKey(s, NEW, OLD)).not.toThrow()
  })

  it('never throws when getItem itself throws', () => {
    const s: LocalStorageLike = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(() => migrateLegacyKey(s, NEW, OLD)).not.toThrow()
  })
})
