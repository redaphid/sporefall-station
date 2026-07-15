import { describe, expect, it } from 'vitest'
import {
  clampToViewport,
  deOverlap,
  entityLabelAnchor,
  overlaps,
  rectInViewport,
  wrapLabel,
  MAX_LABEL_LINES,
  type Rect,
} from './annotationLayout'

describe('wrapLabel — word-boundary wrapping, bounded lines', () => {
  it('keeps short text on a single line', () => {
    expect(wrapLabel('hello world', 22, 3)).toEqual(['hello world'])
  })

  it('breaks ONLY at word boundaries when words fit', () => {
    const lines = wrapLabel('one two three four', 8, 3)
    expect(lines).toEqual(['one two', 'three', 'four'])
    // No line exceeds the width budget, and no word was split.
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(8)
    expect(lines.join(' ')).toBe('one two three four')
  })

  it('hard-breaks a SINGLE word that is longer than the max (the only mid-word case)', () => {
    const lines = wrapLabel('abcdefghij', 4, 3)
    expect(lines).toEqual(['abcd', 'efgh', 'ij'])
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(4)
  })

  it('bounds the line count and marks truncation with an ellipsis', () => {
    const lines = wrapLabel('alpha bravo charlie delta echo foxtrot golf', 6, 3)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines[lines.length - 1].endsWith('…')).toBe(true)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(6)
  })

  it('never returns zero lines (stable render), even for empty text', () => {
    expect(wrapLabel('', 10, 3)).toEqual([''])
    expect(wrapLabel('   ', 10, 3)).toEqual([''])
  })

  it('respects the default MAX_LABEL_LINES ceiling', () => {
    const long = 'word '.repeat(50)
    expect(wrapLabel(long).length).toBeLessThanOrEqual(MAX_LABEL_LINES)
  })
})

describe('clampToViewport — the whole box stays on-screen', () => {
  it('pushes a box off the top-left back inside the inset', () => {
    const r: Rect = { x: -30, y: -20, w: 60, h: 24 }
    const p = clampToViewport(r, 400, 300, 6)
    expect(p.x).toBe(6)
    expect(p.y).toBe(6)
    expect(rectInViewport({ ...r, x: p.x, y: p.y }, 400, 300)).toBe(true)
  })

  it('pushes a box off the bottom-right back inside the inset', () => {
    const r: Rect = { x: 390, y: 290, w: 60, h: 24 }
    const p = clampToViewport(r, 400, 300, 6)
    expect(p.x + r.w).toBeLessThanOrEqual(400 - 6)
    expect(p.y + r.h).toBeLessThanOrEqual(300 - 6)
    expect(rectInViewport({ ...r, x: p.x, y: p.y }, 400, 300)).toBe(true)
  })

  it('leaves an already-inside box untouched', () => {
    const r: Rect = { x: 100, y: 80, w: 40, h: 20 }
    expect(clampToViewport(r, 400, 300)).toEqual({ x: 100, y: 80 })
  })
})

describe('entityLabelAnchor — offset OFF the sprite (never covers it)', () => {
  it('places the label above the sprite by default', () => {
    const w = 40
    const h = 20
    const a = entityLabelAnchor(100, 100, w, h, 20)
    // The label's bottom edge sits strictly above the sprite point.
    expect(a.y + h).toBeLessThanOrEqual(100)
    // Horizontally centred on the sprite.
    expect(a.x + w / 2).toBe(100)
    // The sprite point is NOT inside the label rect.
    expect(overlaps({ x: a.x, y: a.y, w, h }, { x: 100, y: 100, w: 0, h: 0 })).toBe(false)
  })

  it('flips BELOW the sprite when placing above would clip the top', () => {
    const a = entityLabelAnchor(100, 8, 40, 20, 20, 6)
    expect(a.y).toBeGreaterThan(8) // below the sprite, not off the top edge
  })
})

describe('overlaps / deOverlap — de-crowding stacked labels', () => {
  it('detects a real overlap and ignores a bare touch', () => {
    expect(overlaps({ x: 0, y: 0, w: 50, h: 20 }, { x: 10, y: 5, w: 50, h: 20 })).toBe(true)
    expect(overlaps({ x: 0, y: 0, w: 50, h: 20 }, { x: 50, y: 0, w: 50, h: 20 })).toBe(false)
  })

  it('separates two labels dropped on the exact same point', () => {
    const out = deOverlap([
      { x: 0, y: 0, w: 50, h: 20 },
      { x: 0, y: 0, w: 50, h: 20 },
    ])
    expect(out[0]).toEqual({ x: 0, y: 0, w: 50, h: 20 })
    expect(out[1].y).toBeGreaterThanOrEqual(out[0].y + out[0].h)
    expect(overlaps(out[0], out[1])).toBe(false)
  })

  it('leaves no pair overlapping across a crowded cluster', () => {
    const cluster: Rect[] = Array.from({ length: 5 }, (_, i) => ({ x: i * 3, y: i * 2, w: 60, h: 22 }))
    const out = deOverlap(cluster)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) expect(overlaps(out[i], out[j])).toBe(false)
  })
})
