import { describe, it, expect } from 'vitest'
import { RELEASE_NOTES, formatReleaseNotes } from './releaseNotes'

describe('formatReleaseNotes', () => {
  it('renders the seeded curated notes by default', () => {
    const out = formatReleaseNotes()
    expect(out).toEqual([...RELEASE_NOTES])
    expect(out.length).toBeGreaterThan(0)
  })

  it('keeps the seeded notes tiny and player-friendly', () => {
    // Guard the maintained list: one line each, short enough to sit under the
    // version number without dominating the dark menu.
    for (const line of RELEASE_NOTES) {
      expect(line).not.toContain('\n')
      expect(line.length).toBeLessThanOrEqual(44)
      expect(line.trim()).toBe(line)
    }
    expect(RELEASE_NOTES.length).toBeLessThanOrEqual(4)
  })

  it('returns an empty list for empty source (menu shows nothing)', () => {
    expect(formatReleaseNotes([])).toEqual([])
  })

  it('handles a single line', () => {
    expect(formatReleaseNotes(['Only one thing changed'])).toEqual(['Only one thing changed'])
  })

  it('caps the number of lines to maxLines (newest first)', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(formatReleaseNotes(many, { maxLines: 4 })).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops blank / whitespace-only lines so no empty bullets show', () => {
    expect(formatReleaseNotes(['first', '   ', '', '  second  '])).toEqual(['first', 'second'])
  })

  it('truncates over-long lines with a single-char ellipsis', () => {
    const long = 'This is a really long release note that will not fit in the readout'
    const [out] = formatReleaseNotes([long], { maxLen: 20 })
    expect(out.length).toBe(20)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves lines at or under maxLen untouched', () => {
    expect(formatReleaseNotes(['exact'], { maxLen: 5 })).toEqual(['exact'])
    expect(formatReleaseNotes(['four'], { maxLen: 5 })).toEqual(['four'])
  })

  it('is pure — same input yields identical output', () => {
    const src = ['one', 'two']
    expect(formatReleaseNotes(src)).toEqual(formatReleaseNotes(src))
  })

  it('tolerates degenerate options (zero / negative caps)', () => {
    expect(formatReleaseNotes(['x', 'y'], { maxLines: 0 })).toEqual([])
    expect(formatReleaseNotes(['x', 'y'], { maxLines: -3 })).toEqual([])
    // maxLen 0 clamps everything to just the ellipsis.
    expect(formatReleaseNotes(['abc'], { maxLen: 0 })).toEqual(['…'])
  })
})
