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

  it('falls back to SoR for empty / whitespace / missing names', () => {
    expect(toAdvertiseName('')).toBe('SoR')
    expect(toAdvertiseName('   ')).toBe('SoR')
    expect(toAdvertiseName(null)).toBe('SoR')
    expect(toAdvertiseName(undefined)).toBe('SoR')
  })

  it('trims trailing space left by truncation', () => {
    // 'Galaxy S9' -> first 8 chars 'Galaxy S' has no trailing space; 'Galaxy  9' would
    expect(toAdvertiseName('Galaxy S9')).toBe('Galaxy S')
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
})
