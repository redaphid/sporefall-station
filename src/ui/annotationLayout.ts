// Pure text-layout math for the annotation overlay — extracted from the DOM so
// legibility is machine-checkable without a browser. The overlay measures real
// element sizes and feeds them here; these functions decide wrapping, on-screen
// clamping, entity-anchor offset, and de-overlap nudging. No DOM, no pixi.

/** A positioned box in screen pixels. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Max width a label line is allowed to reach (px). The overlay's per-line
 * `white-space:nowrap` + this wrap width keep rendered width under it. */
export const MAX_LABEL_WIDTH = 240
/** Hard ceiling on wrapped lines; longer text is truncated with an ellipsis. */
export const MAX_LABEL_LINES = 3
/** Characters per line the wrapper targets — calibrated so a nowrap line stays
 * comfortably under MAX_LABEL_WIDTH at the overlay's 13px system-ui font. */
export const WRAP_CHARS = 22
/** Line box height (px) the overlay renders each wrapped line at. */
export const LABEL_LINE_HEIGHT = 16
/** Minimum legible font size (px). */
export const MIN_FONT_PX = 13

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Word-wrap `text` into at most `maxLines` lines of at most `maxChars` chars,
 * breaking ONLY at word boundaries. A single word longer than `maxChars` is
 * hard-broken (the only case a break lands mid-word). Overflow past `maxLines`
 * is truncated with an ellipsis on the last line, so the box never grows
 * unbounded. Returns at least one line (possibly empty) for stable rendering.
 */
export const wrapLabel = (text: string, maxChars = WRAP_CHARS, maxLines = MAX_LABEL_LINES): string[] => {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let cur = ''
  const flush = (): void => {
    if (cur) lines.push(cur)
    cur = ''
  }
  for (let w of words) {
    // Hard-break a single oversized word across as many lines as it needs.
    while (w.length > maxChars) {
      flush()
      lines.push(w.slice(0, maxChars))
      w = w.slice(maxChars)
    }
    const candidate = cur ? `${cur} ${w}` : w
    if (candidate.length <= maxChars) cur = candidate
    else {
      flush()
      cur = w
    }
  }
  flush()
  if (lines.length === 0) return ['']
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    const last = kept[maxLines - 1]
    // Trim room for the ellipsis without breaking the ≤ maxChars invariant.
    kept[maxLines - 1] = (last.length >= maxChars ? last.slice(0, maxChars - 1) : last).replace(/\s+$/, '') + '…'
    return kept
  }
  return lines
}

/**
 * Clamp a box's top-left so the WHOLE box stays within the viewport, inset by
 * `margin`. If the box is wider/taller than the viewport it is pinned to the
 * top-left inset (degenerate; real labels are far smaller than the screen).
 */
export const clampToViewport = (r: Rect, vw: number, vh: number, margin = 6): { x: number; y: number } => ({
  x: clamp(r.x, margin, Math.max(margin, vw - margin - r.w)),
  y: clamp(r.y, margin, Math.max(margin, vh - margin - r.h)),
})

/** True iff the box lies fully inside the viewport inset by `margin`. */
export const rectInViewport = (r: Rect, vw: number, vh: number, margin = 0): boolean =>
  r.x >= margin && r.y >= margin && r.x + r.w <= vw - margin && r.y + r.h <= vh - margin

/**
 * Top-left for a label anchored to an entity sprite at screen (sx,sy). Placed
 * horizontally centred on the sprite and lifted so its BOTTOM sits `gap` px above
 * the sprite point — the text never covers the sprite. If that would clip the top
 * of the screen, it flips BELOW the sprite instead.
 */
export const entityLabelAnchor = (
  sx: number,
  sy: number,
  w: number,
  h: number,
  gap = 20,
  topLimit = 6,
): { x: number; y: number } => {
  const above = sy - gap - h
  const y = above < topLimit ? sy + gap : above
  return { x: sx - w / 2, y }
}

/** Overlap in both axes exceeds `thr` px (i.e. the boxes visibly cover). */
export const overlaps = (a: Rect, b: Rect, thr = 2): boolean => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > thr && oy > thr
}

/**
 * Nudge boxes vertically so none overlap, preserving input order (earlier boxes
 * hold their place; later ones are pushed DOWN below whatever they collide with).
 * Deterministic and side-effect-free — returns fresh rects. Two boxes at the same
 * point come out stacked with a `gap` between them.
 */
export const deOverlap = (rects: readonly Rect[], gap = 4, thr = 2): Rect[] => {
  const placed: Rect[] = []
  for (const r of rects) {
    const cur: Rect = { ...r }
    // Re-resolve against all placed boxes until a full pass finds no collision
    // (bounded by the count so a pathological cluster can't spin forever).
    for (let iter = 0; iter <= placed.length; iter++) {
      let moved = false
      for (const p of placed) {
        if (overlaps(cur, p, thr)) {
          cur.y = p.y + p.h + gap
          moved = true
        }
      }
      if (!moved) break
    }
    placed.push(cur)
  }
  return placed
}
