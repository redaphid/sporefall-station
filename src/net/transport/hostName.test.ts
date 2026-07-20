import { describe, expect, it } from 'vitest'
import { ADVERTISE_NAME_MAX, toAdvertiseName, toHostLabel } from './hostName'

describe('toAdvertiseName', () => {
  it('passes short names through unchanged', () => {
    expect(toAdvertiseName('Pixel 8')).toBe('Pixel 8')
  })

  it('never exceeds the advertisement budget', () => {
    expect(toAdvertiseName("Aaron's Razr").length).toBeLessThanOrEqual(ADVERTISE_NAME_MAX)
    expect(toAdvertiseName('a very long phone name').length).toBeLessThanOrEqual(ADVERTISE_NAME_MAX)
  })

  it('truncates long names to the budget', () => {
    expect(toAdvertiseName("Aaron's Razr")).toBe("Aaron's")
  })

  it('collapses runs of whitespace before truncating', () => {
    expect(toAdvertiseName('Sam    S')).toBe('Sam S')
  })

  it('falls back to Spore for empty / whitespace / missing names', () => {
    expect(toAdvertiseName('')).toBe('Spore')
    expect(toAdvertiseName('   ')).toBe('Spore')
    expect(toAdvertiseName(null)).toBe('Spore')
    expect(toAdvertiseName(undefined)).toBe('Spore')
  })

  it('trims trailing space left by truncation', () => {
    // 'Galaxy S9' -> first 8 chars 'Galaxy S' has no trailing space; 'Galaxy  9' would
    expect(toAdvertiseName('Galaxy S9')).toBe('Galaxy S')
  })

  // --- Adversarial: unicode / injection / hostile input ---

  it('collapses newlines and tabs as whitespace before truncating', () => {
    expect(toAdvertiseName('Sam\n\tS')).toBe('Sam S')
    expect(toAdvertiseName('\t\n  Neo  \n')).toBe('Neo')
  })

  it('never exceeds the budget for over-long unicode names', () => {
    expect(toAdvertiseName('日本語のとても長い名前').length).toBeLessThanOrEqual(ADVERTISE_NAME_MAX)
    expect(toAdvertiseName('café ☕ o’clock time').length).toBeLessThanOrEqual(ADVERTISE_NAME_MAX)
  })

  it('does not sever a surrogate pair when truncating (no dangling half-emoji)', () => {
    // 7 ASCII chars + a 2-code-unit emoji: a naive slice(0,8) would keep only the
    // high surrogate and produce an invalid, un-encodable code unit.
    const out = toAdvertiseName('1234567😀')
    expect(out).toBe('1234567')
    expect(/[\uD800-\uDBFF]/.test(out)).toBe(false) // no lone high surrogate
    // Encoding must round-trip cleanly (a lone surrogate becomes U+FFFD).
    expect([...new TextEncoder().encode(out)]).not.toContain(0xef)
  })

  it('keeps a whole emoji that fits inside the budget', () => {
    const out = toAdvertiseName('AB😀')
    expect(out).toBe('AB😀')
    expect(/[\uD800-\uDBFF]/.test(out.slice(-1))).toBe(false)
  })

  it('does not fall back to Spore when the name has real content', () => {
    expect(toAdvertiseName('☕')).toBe('☕')
  })
})

describe('toHostLabel', () => {
  it('uses the advertised name when present', () => {
    expect(toHostLabel('Pixel 8', 'AA:BB:CC:DD:EE:FF')).toBe('Pixel 8')
  })

  it('trims the advertised name', () => {
    expect(toHostLabel('  Pixel 8  ', 'AA:BB:CC:DD:EE:FF')).toBe('Pixel 8')
  })

  it('derives a stable code from the deviceId when no name is advertised', () => {
    expect(toHostLabel(null, 'AA:BB:CC:DD:EE:FF')).toBe('Host EEFF')
    expect(toHostLabel(undefined, 'AA:BB:CC:DD:EE:FF')).toBe('Host EEFF')
    expect(toHostLabel('', 'AA:BB:CC:DD:EE:FF')).toBe('Host EEFF')
  })

  it('keeps two nameless hosts distinguishable', () => {
    const a = toHostLabel(null, '11:22:33:44:55:66')
    const b = toHostLabel(null, '11:22:33:44:AA:BB')
    expect(a).not.toBe(b)
  })

  it('is stable for the same deviceId across scans', () => {
    expect(toHostLabel(null, '11:22:33:44:55:66')).toBe(toHostLabel(null, '11:22:33:44:55:66'))
  })

  it('falls back to Unknown host when neither name nor deviceId is usable', () => {
    expect(toHostLabel(null, '')).toBe('Unknown host')
    expect(toHostLabel('', '::::')).toBe('Unknown host')
  })

  // --- Adversarial: unicode / injection / hostile input ---

  it('preserves a unicode advertised name verbatim (only trimmed)', () => {
    expect(toHostLabel('  日本 ☕  ', 'AA:BB')).toBe('日本 ☕')
  })

  it('strips non-alphanumerics (incl. unicode) from the deviceId before deriving a code', () => {
    expect(toHostLabel(null, 'de:ad:bé:ef')).toBe('Host DBEF') // é and ':' dropped -> 'deadbef' -> last 4
    expect(toHostLabel(null, '☕☕☕☕')).toBe('Unknown host') // nothing alphanumeric survives
  })

  it('does not treat a whitespace-only name as a usable label', () => {
    expect(toHostLabel('   \t\n', 'AA:BB:CC:DD:EE:FF')).toBe('Host EEFF')
  })
})
