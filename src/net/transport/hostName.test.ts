import { describe, expect, it } from 'vitest'
import { ADVERTISE_NAME_MAX, HOST_LABEL_PREFIX, toAdvertiseName, toHostLabel } from './hostName'

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
  // The whole point of the label: a player scanning at a table has to be able to
  // tell that the thing in the list IS the game. Nothing on the air says so —
  // 'Sporefall' is 9 bytes and only 8 fit beside the service UUID — so the label
  // says it instead, which costs nothing and needs no cooperation from the host.
  it('marks every host as the game, whatever the phone is called', () => {
    expect(toHostLabel('Pixel 8', 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · Pixel 8')
    expect(toHostLabel(null, 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · EEFF')
  })

  it.each([
    ['Pixel 8', 'AA:BB:CC:DD:EE:FF'],
    [null, 'AA:BB:CC:DD:EE:FF'],
    ['', ''],
    ['   ', '::::'],
    ['日本 ☕', 'AA:BB'],
  ])('always starts with the game name — name %j, deviceId %j', (name, deviceId) => {
    expect(toHostLabel(name, deviceId).startsWith(HOST_LABEL_PREFIX)).toBe(true)
  })

  it('keeps the cached phone name, so you can tell whose phone it is', () => {
    expect(toHostLabel('  Pixel 8  ', 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · Pixel 8')
  })

  it('derives a stable code from the deviceId when no name is advertised', () => {
    expect(toHostLabel(null, 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · EEFF')
    expect(toHostLabel(undefined, 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · EEFF')
    expect(toHostLabel('', 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · EEFF')
  })

  // Two phones hosting in the same room is the normal case at a playtest, not an
  // edge case. Tagging every row with the game must not cost us the discriminator.
  it('keeps two nameless hosts distinguishable', () => {
    const a = toHostLabel(null, '11:22:33:44:55:66')
    const b = toHostLabel(null, '11:22:33:44:AA:BB')
    expect(a).not.toBe(b)
  })

  it('keeps two named hosts distinguishable', () => {
    expect(toHostLabel('Pixel 8', 'AA:BB')).not.toBe(toHostLabel("Dave's Razr", 'CC:DD'))
  })

  it('is stable for the same deviceId across scans', () => {
    expect(toHostLabel(null, '11:22:33:44:55:66')).toBe(toHostLabel(null, '11:22:33:44:55:66'))
  })

  it('still names the game when neither name nor deviceId is usable', () => {
    // Nothing left to distinguish with — but such a host has no deviceId to
    // connect to either, so there is no pair of them to tell apart.
    expect(toHostLabel(null, '')).toBe('Sporefall host')
    expect(toHostLabel('', '::::')).toBe('Sporefall host')
  })

  // --- Adversarial: unicode / injection / hostile input ---

  it('preserves a unicode advertised name verbatim (only trimmed)', () => {
    expect(toHostLabel('  日本 ☕  ', 'AA:BB')).toBe('Sporefall · 日本 ☕')
  })

  it('strips non-alphanumerics (incl. unicode) from the deviceId before deriving a code', () => {
    expect(toHostLabel(null, 'de:ad:bé:ef')).toBe('Sporefall · DBEF') // é and ':' dropped -> 'deadbef' -> last 4
    expect(toHostLabel(null, '☕☕☕☕')).toBe('Sporefall host') // nothing alphanumeric survives
  })

  it('does not treat a whitespace-only name as a usable label', () => {
    expect(toHostLabel('   \t\n', 'AA:BB:CC:DD:EE:FF')).toBe('Sporefall · EEFF')
  })

  it('stays short enough for the join button at a glance', () => {
    // The NEARBY GAMES rows are min(300px,75vw) at 16px — roughly 30 characters
    // before it wraps. A tag that pushes the discriminator off the row would
    // defeat the purpose of having one.
    expect(toHostLabel('Pixel 8 Pro', 'AA:BB:CC:DD:EE:FF').length).toBeLessThanOrEqual(30)
    expect(toHostLabel(null, 'AA:BB:CC:DD:EE:FF').length).toBeLessThanOrEqual(30)
  })
})
