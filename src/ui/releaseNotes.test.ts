import { describe, it, expect } from 'vitest'
import { RELEASE_NOTES, formatReleaseNotes, selectNotes } from './releaseNotes'

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

describe('selectNotes', () => {
  const note = (date: string, slug: string) => `./releaseNotes/${date}-${slug}.ts`

  it('orders by date prefix, newest first', () => {
    const mods = {
      [note('2026-08-17', 'oldest')]: 'oldest',
      [note('2026-08-19', 'newest')]: 'newest',
      [note('2026-08-18', 'middle')]: 'middle',
    }
    expect(selectNotes(mods)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('caps to the newest count, leaving older files as inert history', () => {
    const mods = Object.fromEntries(
      ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'].map((d) => [note(d, 'x'), d]),
    )
    expect(selectNotes(mods, 2)).toEqual(['2026-08-19', '2026-08-18'])
  })

  it('IGNORES an undated filename instead of letting it pin itself to the top', () => {
    // 'h' > '2', so a raw lexicographic sort would put this above every real
    // note forever and silently evict the newest one.
    const mods = {
      [note('2026-08-19', 'real')]: 'real note',
      './releaseNotes/helpers.ts': 'not a note',
    }
    expect(selectNotes(mods)).toEqual(['real note'])
  })

  it('ignores a non-note file even when it sorts below the dated ones', () => {
    const mods = {
      [note('2026-08-19', 'real')]: 'real note',
      './releaseNotes/index.test.ts': 'not a note',
    }
    expect(selectNotes(mods)).toEqual(['real note'])
  })

  it('drops a malformed note rather than crashing the start menu', () => {
    // A file exporting a named binding instead of a default yields undefined;
    // formatReleaseNotes would throw on .trim() while painting the menu.
    const mods = {
      [note('2026-08-19', 'broken')]: undefined,
      [note('2026-08-18', 'good')]: 'a real note',
    }
    expect(selectNotes(mods)).toEqual(['a real note'])
    expect(() => formatReleaseNotes(selectNotes(mods))).not.toThrow()
  })

  it('drops blank notes BEFORE the cap so they never cost a visible slot', () => {
    const mods = {
      [note('2026-08-19', 'blank')]: '   ',
      [note('2026-08-18', 'a')]: 'first',
      [note('2026-08-17', 'b')]: 'second',
    }
    expect(selectNotes(mods, 2)).toEqual(['first', 'second'])
  })

  it('tolerates an empty directory and a zero/negative cap', () => {
    expect(selectNotes({})).toEqual([])
    expect(selectNotes({ [note('2026-08-19', 'x')]: 'x' }, 0)).toEqual([])
    expect(selectNotes({ [note('2026-08-19', 'x')]: 'x' }, -3)).toEqual([])
  })

  it('is pure — same input yields identical output', () => {
    const mods = { [note('2026-08-19', 'x')]: 'x', [note('2026-08-18', 'y')]: 'y' }
    expect(selectNotes(mods)).toEqual(selectNotes(mods))
  })
})

describe('the shipped note directory', () => {
  it('every visible note is a usable one-liner', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0)
    for (const line of RELEASE_NOTES) {
      expect(typeof line).toBe('string')
      expect(line.trim()).toBe(line)
      expect(line).not.toContain('\n')
    }
  })
})
